//! Platform-specific helpers used by the application, kept out of the control module.

/// Raises the calling thread to `THREAD_PRIORITY_HIGHEST` within the process's normal priority
/// class. Returns whether it succeeded.
///
/// Used only for the two control threads (the loop and its timer), which sleep almost all the
/// time. Measured on Windows under full CPU load: at normal priority, 17 % of their 40 ms
/// intervals exceeded 50 ms; at this priority none exceeded 41 ms (see `docs/timing.md`). The
/// process priority class and the system timer resolution are not changed.
#[cfg(windows)]
pub fn raise_current_thread_priority() -> bool {
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
    };
    // SAFETY: GetCurrentThread returns a pseudo handle that is always valid for the calling
    // thread; SetThreadPriority only changes that thread's scheduling priority.
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST) != 0 }
}

/// No portable equivalent without elevated privileges; the threads keep their priority.
#[cfg(not(windows))]
pub fn raise_current_thread_priority() -> bool {
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn raising_the_priority_of_a_fresh_thread_is_reported() {
        let raised = std::thread::spawn(super::raise_current_thread_priority)
            .join()
            .unwrap();
        assert_eq!(raised, cfg!(windows));
    }
}
