//! Game detection by process name. Used only to tell "game not running" apart from
//! "game running but no telemetry"; live data always comes from the telemetry plugin.

use super::model::Game;
use super::status::GameProcess;

/// Executable names of the 64-bit game clients.
const PROCESS_NAMES: [(&str, Game); 2] =
    [("eurotrucks2.exe", Game::Ets2), ("amtrucks.exe", Game::Ats)];

pub fn classify_process_name(name: &str) -> Option<Game> {
    PROCESS_NAMES
        .iter()
        .find(|(exe, _)| exe.eq_ignore_ascii_case(name))
        .map(|(_, game)| *game)
}

#[cfg(windows)]
pub fn detect_game() -> GameProcess {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    // SAFETY: plain Win32 calls; the snapshot handle is closed on every path and the entry
    // struct is initialized with its required size before use.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return GameProcess::Unknown;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut result = GameProcess::NotRunning;
        let mut ok = Process32FirstW(snapshot, &mut entry) != 0;
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if let Some(game) = classify_process_name(&name) {
                result = GameProcess::Running(game);
                break;
            }
            ok = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        result
    }
}

#[cfg(not(windows))]
pub fn detect_game() -> GameProcess {
    GameProcess::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_games_case_insensitively() {
        assert_eq!(classify_process_name("eurotrucks2.exe"), Some(Game::Ets2));
        assert_eq!(classify_process_name("AMTRUCKS.EXE"), Some(Game::Ats));
        assert_eq!(classify_process_name("eurotrucks2"), None);
        assert_eq!(classify_process_name("explorer.exe"), None);
    }

    #[test]
    fn detection_does_not_fail() {
        // Runs against the real process list; the result depends on the machine.
        let _ = detect_game();
    }
}
