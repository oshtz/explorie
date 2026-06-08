use explorie_core::{FileEntry, list_dir, list_dir_with_sizes};
use explorie_ffmpeg_wrapper::FfmpegTask;
use explorie_plugin_host::{Plugin, PluginHost};
use serde_json::{Value, json};
use std::{env, error::Error, path::PathBuf, process};

fn main() {
    if let Err(err) = run() {
        eprintln!("Error: {err}");
        process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args().skip(1).peekable();
    if args.peek().is_none() {
        print_usage();
        return Ok(());
    }

    let mut with_sizes = false;
    let mut target_path: Option<String> = None;

    enum Mode {
        List,
        PluginCall {
            plugin: String,
            method: String,
            payload: Option<Value>,
        },
        FfmpegPreview {
            input: String,
            output: String,
            copy_audio: bool,
            copy_video: bool,
            video_filters: Vec<String>,
            audio_filters: Vec<String>,
            binary: Option<String>,
        },
    }

    let mut mode = Mode::List;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--with-sizes" | "-s" => with_sizes = true,
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            "--version" | "-V" => {
                print_version();
                return Ok(());
            }
            "plugin-call" => {
                let plugin = args.next().ok_or("plugin-call requires a plugin name")?;
                let method = args.next().ok_or("plugin-call requires a method name")?;
                let payload = args.next().map(|p| serde_json::from_str(&p)).transpose()?;
                mode = Mode::PluginCall {
                    plugin,
                    method,
                    payload,
                };
                break;
            }
            "ffmpeg-preview" => {
                let input = args.next().ok_or("ffmpeg-preview requires an input path")?;
                let output = args
                    .next()
                    .ok_or("ffmpeg-preview requires an output path")?;
                let mut copy_audio = false;
                let mut copy_video = false;
                let mut video_filters = Vec::new();
                let mut audio_filters = Vec::new();
                let mut binary = None;
                while let Some(flag) = args.next() {
                    match flag.as_str() {
                        "--copy-audio" => copy_audio = true,
                        "--copy-video" => copy_video = true,
                        "--vf" => {
                            let val = args.next().ok_or("--vf requires a filter expression")?;
                            video_filters.push(val);
                        }
                        "--af" => {
                            let val = args.next().ok_or("--af requires a filter expression")?;
                            audio_filters.push(val);
                        }
                        "--binary" => {
                            binary = Some(args.next().ok_or("--binary requires a path to ffmpeg")?);
                        }
                        other => {
                            return Err(format!(
                                "unexpected ffmpeg-preview option '{other}'\n\n{}",
                                usage_line()
                            )
                            .into());
                        }
                    }
                }
                mode = Mode::FfmpegPreview {
                    input,
                    output,
                    copy_audio,
                    copy_video,
                    video_filters,
                    audio_filters,
                    binary,
                };
                break;
            }
            _ if target_path.is_none() => target_path = Some(arg),
            _ => {
                return Err(format!("unexpected argument '{arg}'\n\n{}", usage_line()).into());
            }
        }
    }

    match mode {
        Mode::List => perform_listing(target_path, with_sizes)?,
        Mode::PluginCall {
            plugin,
            method,
            payload,
        } => {
            let host = build_plugin_host();
            let value = host
                .call(&plugin, &method, payload)
                .map_err(|e| format!("plugin error: {e}"))?;
            println!("{}", serde_json::to_string_pretty(&value)?);
        }
        Mode::FfmpegPreview {
            input,
            output,
            copy_audio,
            copy_video,
            video_filters,
            audio_filters,
            binary,
        } => {
            let mut task = FfmpegTask::new(&input, &output);
            if copy_audio {
                task = task.copy_audio(true);
            }
            if copy_video {
                task = task.copy_video(true);
            }
            for f in video_filters {
                task = task.add_video_filter(f);
            }
            for f in audio_filters {
                task = task.add_audio_filter(f);
            }
            if let Some(bin) = binary {
                task.binary = Some(PathBuf::from(bin));
            }
            let cmd = task.build();
            let joined = cmd.args.join(" ");
            println!("ffmpeg command:");
            println!("{} {}", cmd.binary.display(), joined);
        }
    }

    Ok(())
}

fn perform_listing(target_path: Option<String>, with_sizes: bool) -> Result<(), Box<dyn Error>> {
    let path = target_path.unwrap_or_else(|| ".".to_string());
    let path = PathBuf::from(path);

    let mut entries = list_dir_with_sizes(&path, with_sizes)?;
    entries.sort_by_key(entry_name);

    if entries.is_empty() {
        println!("(empty)");
        return Ok(());
    }

    println!("{:<4} {:>12} NAME", "TYPE", "SIZE");
    for entry in entries {
        let name = entry_name(&entry);
        let type_label = if entry.is_dir { "DIR" } else { "FILE" };
        let size_label = if entry.is_dir && !with_sizes {
            "-".to_string()
        } else {
            format_bytes(entry.size)
        };
        let hidden_marker = if entry.hidden { " (hidden)" } else { "" };
        let custom_marker = if entry.custom.is_empty() {
            String::new()
        } else {
            format!(" [{} custom]", entry.custom.len())
        };

        println!(
            "{:<4} {:>12} {}{}{}",
            type_label, size_label, name, hidden_marker, custom_marker
        );
    }

    Ok(())
}

fn entry_name(entry: &FileEntry) -> String {
    let mut name = entry
        .path
        .file_name()
        .map(|os_str| os_str.to_string_lossy().to_string())
        .unwrap_or_else(|| entry.path.display().to_string());
    if entry.is_dir {
        name.push('/');
    }
    name
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_index = 0;

    while value >= 1024.0 && unit_index < UNITS.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }

    if unit_index == 0 {
        format!("{bytes} {}", UNITS[unit_index])
    } else {
        format!("{value:.1} {}", UNITS[unit_index])
    }
}

fn print_usage() {
    println!("{}", usage_line());
    println!("Subcommands:");
    println!("  explorie [--with-sizes] [path]     List directory contents (default)");
    println!("  explorie plugin-call <plugin> <method> [json]   Call a registered plugin");
    println!(
        "  explorie ffmpeg-preview <input> <output> [--copy-audio] [--copy-video] [--vf expr] [--af expr] [--binary path]"
    );
}

fn usage_line() -> String {
    "Usage: explorie [--with-sizes] [path] | plugin-call ... | ffmpeg-preview ...".to_string()
}

fn print_version() {
    println!("explorie-cli {}", env!("CARGO_PKG_VERSION"));
}

fn build_plugin_host() -> PluginHost {
    let host = PluginHost::new();
    let _ = host.register(InfoPlugin);
    host
}

struct InfoPlugin;

impl Plugin for InfoPlugin {
    fn name(&self) -> &str {
        "info"
    }

    fn invoke(
        &self,
        method: &str,
        payload: Option<Value>,
    ) -> Result<Value, explorie_plugin_host::PluginError> {
        match method {
            "ping" => Ok(json!({ "ok": true })),
            "summary" => {
                let path = payload
                    .as_ref()
                    .and_then(|v| v.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(".");
                let entries = list_dir(PathBuf::from(path).as_path()).map_err(|e| {
                    explorie_plugin_host::PluginError::Invocation {
                        plugin: self.name().into(),
                        method: method.into(),
                        message: e.to_string(),
                    }
                })?;
                let mut dirs = 0usize;
                let mut files = 0usize;
                for e in &entries {
                    if e.is_dir {
                        dirs += 1;
                    } else {
                        files += 1;
                    }
                }
                Ok(json!({
                    "path": path,
                    "entries": entries.len(),
                    "dirs": dirs,
                    "files": files
                }))
            }
            other => Err(explorie_plugin_host::PluginError::MethodNotFound {
                plugin: self.name().into(),
                method: other.into(),
            }),
        }
    }

    fn methods(&self) -> &[&'static str] {
        &["ping", "summary"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_bytes_humanizes_values() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
    }
}
