use std::io::Read;
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use napi::{Env, Task};
use napi::bindgen_prelude::AsyncTask;
use napi_derive::napi;

use super::ring_buffer::CircularStreamBuffer;

#[napi(object)]
#[derive(Debug, Clone)]
pub struct RsExecutionResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: i64,
    pub timed_out: bool,
    pub is_sandboxed: bool,
    pub cancelled: bool,
    pub output_incomplete: bool,
}

static EXECUTION_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn execution_cancellations() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    EXECUTION_CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn cancel_execution(execution_id: &str) -> bool {
    let Ok(registry) = execution_cancellations().lock() else { return false; };
    let Some(control) = registry.get(execution_id) else { return false; };
    control.store(true, Ordering::Release);
    true
}

pub struct ExecuteCommandTask {
    command: String,
    cwd: String,
    timeout_ms: u64,
    max_output_bytes: usize,
    memory_limit_mb: u32,
    execution_id: String,
    environment: Vec<String>,
    cancelled: Arc<AtomicBool>,
}

impl Task for ExecuteCommandTask {
    type Output = RsExecutionResult;
    type JsValue = RsExecutionResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let result = execute_isolated_command_with_control(
            &self.command,
            &self.cwd,
            self.timeout_ms,
            self.max_output_bytes,
            self.memory_limit_mb,
            Some(&self.cancelled),
            &self.environment,
        );
        if !self.execution_id.is_empty() {
            if let Ok(mut registry) = execution_cancellations().lock() {
                registry.remove(&self.execution_id);
            }
        }
        Ok(result)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

pub fn execute_isolated_command_async(
    command: String,
    cwd: String,
    timeout_ms: u64,
    max_output_bytes: usize,
    memory_limit_mb: u32,
    execution_id: String,
    environment: Vec<String>,
) -> AsyncTask<ExecuteCommandTask> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if !execution_id.is_empty() {
        if let Ok(mut registry) = execution_cancellations().lock() {
            registry.insert(execution_id.clone(), Arc::clone(&cancelled));
        }
    }
    AsyncTask::new(ExecuteCommandTask {
        command,
        cwd,
        timeout_ms,
        max_output_bytes,
        memory_limit_mb,
        execution_id,
        environment,
        cancelled,
    })
}

#[cfg(target_os = "windows")]
mod win_job {
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null_mut;

    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;
    #[allow(non_camel_case_types)]
    type SIZE_T = usize;
    const FALSE: BOOL = 0;

    #[repr(C)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: DWORD,
        minimum_working_set_size: SIZE_T,
        maximum_working_set_size: SIZE_T,
        active_process_limit: DWORD,
        affinity: usize,
        priority_class: DWORD,
        scheduling_class: DWORD,
    }

    #[repr(C)]
    struct IO_COUNTERS {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        io_info: IO_COUNTERS,
        process_memory_limit: SIZE_T,
        job_memory_limit: SIZE_T,
        peak_process_memory_used: SIZE_T,
        peak_job_memory_used: SIZE_T,
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x2000;
    const JOB_OBJECT_LIMIT_JOB_MEMORY: DWORD = 0x0200;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: DWORD = 0x0008;
    const JOB_OBJECT_EXTENDED_LIMIT_INFO: i32 = 9;

    extern "system" {
        fn CreateJobObjectW(lpJobAttributes: *mut std::ffi::c_void, lpName: *const u16) -> HANDLE;
        fn SetInformationJobObject(
            hJob: HANDLE,
            JobObjectInformationClass: i32,
            lpJobObjectInformation: *mut std::ffi::c_void,
            cbJobObjectInformationLength: DWORD,
        ) -> BOOL;
        fn AssignProcessToJobObject(hJob: HANDLE, hProcess: HANDLE) -> BOOL;
        fn TerminateJobObject(hJob: HANDLE, uExitCode: u32) -> BOOL;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
    }

    pub struct WinJobGuard {
        job: HANDLE,
    }

    impl WinJobGuard {
        pub fn create(memory_limit_mb: u32) -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(null_mut(), null_mut());
                if job.is_null() {
                    return None;
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                let mut flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                if memory_limit_mb > 0 {
                    flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                    info.job_memory_limit = (memory_limit_mb as usize) * 1024 * 1024;
                }

                // Chống fork bomb quá 128 tiến trình con
                flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                info.basic_limit_information.active_process_limit = 128;
                info.basic_limit_information.limit_flags = flags;

                let res = SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFO,
                    &mut info as *mut _ as *mut std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
                );

                if res == FALSE {
                    CloseHandle(job);
                    return None;
                }

                Some(Self { job })
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> bool {
            unsafe {
                let handle = child.as_raw_handle() as HANDLE;
                AssignProcessToJobObject(self.job, handle) != FALSE
            }
        }

        pub fn terminate(&self, exit_code: u32) {
            unsafe {
                TerminateJobObject(self.job, exit_code);
            }
        }
    }

    impl Drop for WinJobGuard {
        fn drop(&mut self) {
            unsafe {
                if !self.job.is_null() {
                    CloseHandle(self.job);
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Thực thi lệnh trong môi trường cách ly cứng có Job Object / Sandbox Guard, timeout và kiểm soát buffer
pub fn execute_isolated_command(
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    max_output_bytes: usize,
    memory_limit_mb: u32,
) -> RsExecutionResult {
    execute_isolated_command_with_control(command, cwd, timeout_ms, max_output_bytes, memory_limit_mb, None, &[])
}

fn execute_isolated_command_with_control(
    command: &str,
    cwd: &str,
    timeout_ms: u64,
    max_output_bytes: usize,
    memory_limit_mb: u32,
    cancellation: Option<&Arc<AtomicBool>>,
    environment: &[String],
) -> RsExecutionResult {
    let start_time = Instant::now();

    if cancellation.is_some_and(|control| control.load(Ordering::Acquire)) {
        return RsExecutionResult {
            exit_code: 130,
            stdout: String::new(),
            stderr: "Command was cancelled before execution.".to_string(),
            duration_ms: 0,
            timed_out: false,
            is_sandboxed: false,
            cancelled: true,
            output_incomplete: false,
        };
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd.exe");
        c.raw_arg(format!("/d /s /c \"{}\"", command));
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };

    cmd.current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !environment.is_empty() {
        cmd.env_clear();
        for entry in environment {
            if let Some((key, value)) = entry.split_once('=') {
                cmd.env(key, value);
            }
        }
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return RsExecutionResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: format!("Spawn failed: {}", err),
                duration_ms: start_time.elapsed().as_millis() as i64,
                timed_out: false,
                is_sandboxed: false,
                cancelled: false,
                output_incomplete: false,
            };
        }
    };

    // Windows Job Object Hard Sandbox Guard
    #[cfg(target_os = "windows")]
    let job_guard = win_job::WinJobGuard::create(if memory_limit_mb == 0 { 2048 } else { memory_limit_mb });
    
    #[cfg(target_os = "windows")]
    let mut is_sandboxed = false;
    #[cfg(target_os = "windows")]
    if let Some(ref job) = job_guard {
        is_sandboxed = job.assign(&child);
    }

    #[cfg(not(target_os = "windows"))]
    let is_sandboxed = false;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();

    let max_bytes = if max_output_bytes == 0 { 50000 } else { max_output_bytes };

    // Luồng đọc stdout
    thread::spawn(move || {
        let mut buf = CircularStreamBuffer::new(max_bytes);
        if let Some(ref mut pipe) = stdout_pipe {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 { break; }
                buf.write(&chunk[..n]);
            }
        }
        let _ = stdout_tx.send(buf.to_string_truncated());
    });

    // Luồng đọc stderr
    thread::spawn(move || {
        let mut buf = CircularStreamBuffer::new(max_bytes);
        if let Some(ref mut pipe) = stderr_pipe {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 { break; }
                buf.write(&chunk[..n]);
            }
        }
        let _ = stderr_tx.send(buf.to_string_truncated());
    });

    // Vòng lặp chờ tiến trình kèm timeout
    let timeout_duration = Duration::from_millis(timeout_ms);
    // The process runs on a libuv worker; a short wait keeps cancellation and
    // completion detection responsive without blocking Node's event loop.
    let check_interval = Duration::from_millis(5);
    let mut timed_out = false;
    let mut cancelled = false;

    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break status.code().unwrap_or(0);
            }
            Ok(None) => {
                if cancellation.is_some_and(|control| control.load(Ordering::Acquire)) {
                    cancelled = true;
                    #[cfg(target_os = "windows")]
                    if let Some(ref job) = job_guard {
                        job.terminate(130);
                    }
                    let _ = child.kill();
                    break 130;
                }
                if start_time.elapsed() >= timeout_duration {
                    timed_out = true;
                    #[cfg(target_os = "windows")]
                    if let Some(ref job) = job_guard {
                        job.terminate(1);
                    }
                    let _ = child.kill();
                    break -1;
                }
                thread::sleep(check_interval);
            }
            Err(_) => {
                #[cfg(target_os = "windows")]
                if let Some(ref job) = job_guard {
                    job.terminate(1);
                }
                let _ = child.kill();
                break -1;
            }
        }
    };

    let stdout_result = stdout_rx.recv_timeout(Duration::from_millis(500));
    let stderr_result = stderr_rx.recv_timeout(Duration::from_millis(500));
    let output_incomplete = stdout_result.is_err() || stderr_result.is_err();
    let stdout = stdout_result.unwrap_or_default();
    let stderr = stderr_result.unwrap_or_default();

    RsExecutionResult {
        exit_code,
        stdout,
        stderr,
        duration_ms: start_time.elapsed().as_millis() as i64,
        timed_out,
        is_sandboxed,
        cancelled,
        output_incomplete,
    }
}
