// The page is built by Vite into web/dist and embedded in a release binary, as
// the Brotli and gzip copies Vite writes beside each asset where there are any.
// PATCH_WEB_DIST points elsewhere, for example at a snapshot of the page. A
// development build embeds nothing and reads the folder at run time.
use std::fmt::Write;
use std::path::{Path, PathBuf};

fn main() {
    // Absolute, so neither the embedded paths nor a development build depend on where they are read from.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dist = match std::env::var("PATCH_WEB_DIST") {
        Ok(dir) => manifest.join(dir),
        Err(_) => manifest.join("../web/dist"),
    };
    let dist = std::path::absolute(&dist).unwrap_or(dist).display().to_string();
    println!("cargo:rustc-env=PATCH_WEB_DIST={dist}");
    println!("cargo:rerun-if-env-changed=PATCH_WEB_DIST");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    if release {
        println!("cargo:rerun-if-changed={dist}");
    }
    let mut table = String::from("&[\n");
    if release {
        let dist = PathBuf::from(&dist);
        let mut files = Vec::new();
        walk(&dist, &mut files);
        let mut assets: Vec<(String, PathBuf)> = files
            .into_iter()
            .filter(|file| !matches!(file.extension().and_then(|e| e.to_str()), Some("br" | "gz")))
            .map(|file| (file.strip_prefix(&dist).unwrap().to_string_lossy().replace('\\', "/"), file))
            .collect();
        assert!(!assets.is_empty(), "{} holds no page; run `bun run build:web` first.", dist.display());
        assets.sort();
        for (name, file) in assets {
            // The page itself is served as it is: the server writes the settings into it.
            let entry = name == "index.html";
            let sibling = |ext: &str| {
                let path = PathBuf::from(format!("{}.{ext}", file.display()));
                (!entry && path.is_file()).then(|| format!("Some(include_bytes!({:?}))", path.display().to_string()))
            };
            let (br, gz) = (sibling("br"), sibling("gz"));
            // An asset with a gzip copy is kept only compressed.
            let raw = match gz {
                Some(_) => "None".to_string(),
                None => format!("Some(include_bytes!({:?}))", file.display().to_string()),
            };
            let none = || "None".to_string();
            writeln!(
                table,
                "    Asset {{ name: {name:?}, raw: {raw}, br: {}, gz: {} }},",
                br.unwrap_or_else(none),
                gz.unwrap_or_else(none)
            )
            .unwrap();
        }
    }
    table.push(']');
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("page.rs");
    std::fs::write(out, table).unwrap();
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, files);
        } else {
            files.push(path);
        }
    }
}
