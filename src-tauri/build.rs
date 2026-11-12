fn main() {
    let mut attributes = tauri_build::Attributes::new();
    if embeds_manifest_with_linker() {
        // tauri-build embeds its default application manifest (the Common Controls v6
        // dependency) into binaries only. Test executables then lack it, and the Windows loader
        // refuses to start them (STATUS_ENTRYPOINT_NOT_FOUND for TaskDialogIndirect). Embed the
        // same manifest through the linker instead, for every linked artifact including tests.
        // `windows-app-manifest.xml` is an unchanged copy of tauri-build's default.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::env::current_dir()
            .expect("build script working directory")
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        // No UAC section: keep the manifest exactly as tauri-build would embed it.
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// The MSVC linker arguments above apply only to Windows MSVC targets.
fn embeds_manifest_with_linker() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
}
