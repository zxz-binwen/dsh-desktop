// DeepSeek Harness desktop source-launcher shell for macOS, Windows, and
// Linux. The window shows the bundled splash while a boot orchestrator
// (desktop/boot.mjs, run under system node) syncs and builds the managed
// repository clone, then the window navigates to the `dsh web` URL reported
// on the orchestrator's stdout.
//
// Shutdown containment differs by platform: Unix shells the boot tree as a
// process group (SIGTERM, then SIGKILL after the grace); Windows assigns it
// to a Job Object with kill-on-job-close, so the tree dies even on a shell
// crash, and has no signal-based graceful phase at all.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(unix)]
use libc::{kill, SIGKILL, SIGTERM};

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Matches the backend's own process-shutdown grace plus scheduling margin.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(5_500);

/// The boot orchestrator plus its platform containment handle: the Unix
/// process-group id (signals reach boot, node, pnpm/git children, and the dsh
/// backend alike) or the Windows Job Object whose close kills the whole tree.
struct BootProcess {
    child: Child,
    #[cfg(unix)]
    containment: i32,
    #[cfg(windows)]
    containment: JobHandle,
}

/// Send wrapper for the Job Object handle: a kernel handle is an opaque value
/// safe to move across threads; every use and the single close happen under
/// the ShellState boot mutex, so the raw-pointer Send impl is sound.
#[cfg(windows)]
struct JobHandle(HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}

#[derive(Default)]
struct ShellState {
    boot: Mutex<Option<BootProcess>>,
    /// Set once the window navigated to the backend URL: the splash is gone by
    /// then, so log events are dropped and failures switch to a native dialog.
    ready: AtomicBool,
    /// Gates the first boot on the splash having attached its event listener:
    /// emitted events reach nobody before then, so an early spawn failure
    /// would vanish instead of surfacing on the splash.
    splash_ready: AtomicBool,
    /// Set once a failure reached the UI or the orchestrator died; the stdout
    /// EOF guard stays quiet then instead of clobbering the reported error.
    failed: AtomicBool,
    /// Set while the shell is tearing the boot tree down; boot events are
    /// ignored so quitting never surfaces a failure dialog.
    shutting_down: AtomicBool,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(ShellState::default())
        .invoke_handler(tauri::generate_handler![restart_boot, splash_ready])
        .setup(|_app| Ok(()))
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else { return };
            api.prevent_close();
            let handle = window.app_handle().clone();
            thread::spawn(move || {
                shutdown_boot(&handle);
                handle.exit(0);
            });
        })
        .build(tauri::generate_context!())
        .expect("build the dsh desktop shell")
        .run(|app_handle, event| {
            // Covers every non-window exit path (dock/taskbar quit, logout).
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_boot(app_handle);
            }
        });
}

/// Start the boot orchestrator; the caller owns the slot (empty or drained).
fn spawn_boot(app: &AppHandle) {
    let state = app.state::<ShellState>();
    state.failed.store(false, Ordering::SeqCst);
    state.shutting_down.store(false, Ordering::SeqCst);
    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            emit_error(app, format!("cannot resolve the application data directory: {error}"), None);
            return;
        }
    };
    if let Err(error) = fs::create_dir_all(&data_dir) {
        emit_error(app, format!("cannot create the application data directory: {error}"), None);
        return;
    }
    let boot_script = app.path().resource_dir().expect("resources resolve beside the app").join("boot.mjs");

    let mut command = Command::new("node");
    command
        .arg(&boot_script)
        .arg(&data_dir)
        .current_dir(&data_dir)
        .env("PATH", augmented_path(&data_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            emit_error(app, format!("cannot spawn node for the boot orchestrator: {error}"), Some("Install Node.js 24 from https://nodejs.org".into()));
            return;
        }
    };

    #[cfg(unix)]
    // With process_group(0) the group id equals the child pid.
    let containment = child.id() as i32;
    #[cfg(windows)]
    let containment = match assign_kill_on_close_job(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            emit_error(app, format!("cannot contain the boot process in a Job Object: {error}"), None);
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => handle_boot_line(&app, &line),
                    Err(_) => break,
                }
            }
            // The orchestrator died without readiness and without reporting a
            // failure: surface a generic error so the splash always ends on a
            // retry affordance instead of hanging on the current phase.
            let state = app.state::<ShellState>();
            if !state.ready.load(Ordering::SeqCst)
                && !state.failed.load(Ordering::SeqCst)
                && !state.shutting_down.load(Ordering::SeqCst)
            {
                emit_error(
                    &app,
                    "the boot orchestrator exited before the server was ready".into(),
                    Some("See the log tail above, then retry".into()),
                );
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(line) => emit_event(&app, &json!({ "type": "log", "line": line })),
                    Err(_) => break,
                }
            }
        });
    }
    *state.boot.lock().unwrap() = Some(BootProcess { child, containment });
}

/// Splash retry: drain the previous boot tree, then start a fresh one.
#[tauri::command]
fn restart_boot(app: AppHandle) {
    shutdown_boot(&app);
    app.state::<ShellState>().ready.store(false, Ordering::SeqCst);
    spawn_boot(&app);
}

/// The splash invokes this once its event listener is attached; the first boot
/// starts here so no emitted event can predate its only consumer.
#[tauri::command]
fn splash_ready(app: AppHandle) {
    let state = app.state::<ShellState>();
    if state.splash_ready.swap(true, Ordering::SeqCst) {
        return;
    }
    spawn_boot(&app);
}

/// Terminate the boot process tree. Idempotent; safe from any exit path.
fn shutdown_boot(app: &AppHandle) {
    let state = app.state::<ShellState>();
    state.shutting_down.store(true, Ordering::SeqCst);
    let mut slot = state.boot.lock().unwrap();
    let Some(mut boot) = slot.take() else { return };
    request_graceful_exit(&boot);
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    loop {
        match boot.child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => break,
        }
    }
    force_kill_tree(&boot);
    let _ = boot.child.wait();
}

/// Ask the tree to exit on its own: Unix signals the process group; Windows
/// posts WM_CLOSE through taskkill, which console processes typically ignore
/// (the force path below is the real terminator there).
#[cfg(unix)]
fn request_graceful_exit(boot: &BootProcess) {
    unsafe { kill(-boot.containment, SIGTERM) };
}

#[cfg(windows)]
fn request_graceful_exit(boot: &BootProcess) {
    let _ = Command::new("taskkill")
        .args(["/PID", &boot.child.id().to_string(), "/T"])
        .status();
}

/// Kill whatever remains of the tree after the grace window expired.
#[cfg(unix)]
fn force_kill_tree(boot: &BootProcess) {
    unsafe { kill(-boot.containment, SIGKILL) };
}

#[cfg(windows)]
fn force_kill_tree(boot: &BootProcess) {
    // Closing the kill-on-close job handle terminates every process assigned
    // to the job, including the whole spawned tree.
    unsafe { CloseHandle(boot.containment.0) };
}

/// Put the freshly spawned child into a Job Object that kills its entire tree
/// when the handle closes — the shell holds the only handle, so the tree dies
/// even if the shell itself crashes. The child cannot have spawned anything
/// yet (node startup takes far longer than this assignment).
#[cfg(windows)]
fn assign_kill_on_close_job(child: &Child) -> Result<JobHandle, String> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err("CreateJobObjectW returned null".into());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0 {
            CloseHandle(job);
            return Err("SetInformationJobObject failed".into());
        }
        if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
            CloseHandle(job);
            return Err("AssignProcessToJobObject failed".into());
        }
        Ok(JobHandle(job))
    }
}

/// A GUI process inherits a minimal PATH that never contains the user's node
/// installation (nvm, homebrew, Program Files, version managers). Collect the
/// common node roots for the platform ahead of that PATH so `node`,
/// `corepack`, and `pnpm` resolve for the boot orchestrator.
fn augmented_path(data_dir: &std::path::Path) -> String {
    let mut prefixes: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("DSH_DESKTOP_NODE_BIN_DIR") {
        prefixes.push(dir.into());
    }
    // The config.json nodeDir key is authoritative when present; boot.mjs
    // validates the whole file, so a lenient read here cannot mask errors.
    if let Ok(raw) = fs::read_to_string(data_dir.join("config.json")) {
        if let Ok(node_dir) = serde_json::from_str::<Value>(&raw) {
            if let Some(dir) = node_dir.get("nodeDir").and_then(Value::as_str) {
                prefixes.push(dir.into());
            }
        }
    }
    collect_platform_node_roots(&mut prefixes);
    let separator = if cfg!(windows) { ";" } else { ":" };
    let existing = std::env::var_os("PATH").unwrap_or_default().to_string_lossy().into_owned();
    let mut parts: Vec<String> = prefixes
        .into_iter()
        .filter(|dir| has_node_binary(dir))
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    parts.push(existing);
    parts.join(separator)
}

/// Append the platform's conventional node installation roots to `prefixes`.
#[cfg(unix)]
fn collect_platform_node_roots(prefixes: &mut Vec<std::path::PathBuf>) {
    let Some(home) = std::env::var_os("HOME") else { return };
    let home = std::path::PathBuf::from(home);
    // Newest nvm-installed node wins: v24.19.0 > v20.20.2 numerically.
    let nvm_dir = home.join(".nvm/versions/node");
    let mut newest: Option<(Vec<u64>, std::path::PathBuf)> = None;
    if let Ok(entries) = fs::read_dir(&nvm_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix('v') else { continue };
            let version: Vec<u64> = rest.split('.').filter_map(|part| part.parse().ok()).collect();
            if version.len() != 3 {
                continue;
            }
            let candidate = entry.path().join("bin");
            if candidate.join("node").exists() && newest.as_ref().is_none_or(|(best, _)| version > *best) {
                newest = Some((version, candidate));
            }
        }
    }
    if let Some((_, dir)) = newest {
        prefixes.push(dir);
    }
    prefixes.push(home.join(".volta/bin"));
    prefixes.push(home.join(".local/share/mise/shims"));
    prefixes.push("/opt/homebrew/bin".into());
    prefixes.push("/usr/local/bin".into());
}

#[cfg(windows)]
fn collect_platform_node_roots(prefixes: &mut Vec<std::path::PathBuf>) {
    if let Some(dir) = std::env::var_os("ProgramFiles") {
        prefixes.push(std::path::PathBuf::from(dir).join("nodejs"));
    }
    if let Some(dir) = std::env::var_os("ProgramFiles(x86)") {
        prefixes.push(std::path::PathBuf::from(dir).join("nodejs"));
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = std::path::PathBuf::from(home);
        prefixes.push(home.join(r".volta\bin"));
        prefixes.push(home.join(r"scoop\shims"));
    }
    if let Some(dir) = std::env::var_os("APPDATA") {
        prefixes.push(std::path::PathBuf::from(dir).join("nvm"));
    }
}

/// Directory filter accepting both Unix `node` and Windows `node.exe`.
fn has_node_binary(dir: &std::path::Path) -> bool {
    dir.join("node").exists() || dir.join("node.exe").exists()
}

/// Dispatch one boot orchestrator stdout line: protocol JSON when it parses,
/// a plain log line otherwise.
fn handle_boot_line(app: &AppHandle, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        emit_event(app, &json!({ "type": "log", "line": line }));
        return;
    };
    let state = app.state::<ShellState>();
    let ready = state.ready.load(Ordering::SeqCst);
    let shutting_down = state.shutting_down.load(Ordering::SeqCst);
    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
        "ready" => {
            let url = value.get("url").and_then(Value::as_str).unwrap_or_default();
            match url.parse::<tauri::Url>() {
                Ok(url) => {
                    state.ready.store(true, Ordering::SeqCst);
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(error) = window.navigate(url.clone()) {
                            emit_error(app, format!("cannot navigate to the backend URL {url}: {error}"), None);
                        }
                    }
                }
                Err(_) => emit_error(app, format!("the boot orchestrator reported a malformed URL: {url}"), None),
            }
        }
        "log" => {
            if !ready {
                emit_event(app, &value);
            }
        }
        // During the shell's own teardown the dialog would compete with the
        // exit path; the orchestrator also suppresses its normal-exit event
        // once it received the shutdown signal.
        "error" | "exited" if ready && !shutting_down => {
            state.failed.store(true, Ordering::SeqCst);
            show_backend_dialog(app, &value);
        }
        "error" | "exited" => {
            state.failed.store(true, Ordering::SeqCst);
            emit_event(app, &value);
        }
        _ => emit_event(app, &value),
    }
}

/// After the splash is gone, failures surface as a native dialog offering a
/// full-shell relaunch; the dead page underneath carries no retry affordance.
fn show_backend_dialog(app: &AppHandle, value: &Value) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let detail = value
        .get("message")
        .or_else(|| value.get("hint"))
        .and_then(Value::as_str)
        .unwrap_or("the backend exited");
    let handle = app.clone();
    app.dialog()
        .message(format!("The DeepSeek Harness server stopped.\n\n{detail}"))
        .title("DeepSeek Harness")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom("Relaunch".into(), "Quit".into()))
        .show(move |relaunch| {
            if relaunch {
                handle.restart();
            } else {
                handle.exit(1);
            }
        });
}

fn emit_event(app: &AppHandle, payload: &Value) {
    let _ = app.emit("boot-event", payload.clone());
}

fn emit_error(app: &AppHandle, message: String, hint: Option<String>) {
    app.state::<ShellState>().failed.store(true, Ordering::SeqCst);
    let mut payload = json!({ "type": "error", "message": message });
    if let Some(hint) = hint {
        payload["hint"] = Value::String(hint);
    }
    emit_event(app, &payload);
}
