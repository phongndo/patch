// The page is built by Vite into web/dist and embedded in the binary.
// PATCH_WEB_DIST points elsewhere, for example at a snapshot of the page.
fn main() {
    let dist = std::env::var("PATCH_WEB_DIST").unwrap_or_else(|_| format!("{}/../web/dist", env!("CARGO_MANIFEST_DIR")));
    println!("cargo:rustc-env=PATCH_WEB_DIST={dist}");
    println!("cargo:rerun-if-env-changed=PATCH_WEB_DIST");
    // A development build reads it at run time.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:rerun-if-changed={dist}");
    }
}
