use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use serde_json::{json, Value};
use transcribe_cpp::{
    Backend, Capabilities, Error, Model, ModelOptions, RunOptions, Session, Transcript,
};

struct LoadedModel {
    id: String,
    path: PathBuf,
    model: Model,
    session: Session,
    capabilities: Capabilities,
    requested_backend: Backend,
    backend_fallback: bool,
}

fn error_value(id: Option<u64>, code: &str, message: impl Into<String>) -> Value {
    json!({
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message.into() }
    })
}

fn success_value(id: Option<u64>, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result })
}

fn write_message(output: &mut impl Write, message: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *output, message)?;
    output.write_all(b"\n")?;
    output.flush()
}

fn write_event(output: &Arc<Mutex<io::Stdout>>, message: &Value) -> io::Result<()> {
    let mut output = output.lock().unwrap_or_else(|error| error.into_inner());
    write_message(&mut *output, message)
}

fn backend_for_preference(preference: &str) -> Backend {
    match preference {
        "cpu" => Backend::Cpu,
        "metal" => Backend::Metal,
        "vulkan" => Backend::Vulkan,
        "cuda" => Backend::Cuda,
        "rocm" => Backend::Rocm,
        "gpu" => {
            #[cfg(target_os = "macos")]
            {
                Backend::Metal
            }
            #[cfg(not(target_os = "macos"))]
            {
                Backend::Vulkan
            }
        }
        _ => Backend::Auto,
    }
}

fn transcript_segments_json(segments: &[transcribe_cpp::Segment]) -> Vec<Value> {
    segments
        .iter()
        .map(|segment| {
            json!({
                "t0Ms": segment.t0_ms,
                "t1Ms": segment.t1_ms,
                "text": segment.text,
            })
        })
        .collect()
}

fn load_model_with_backend(path: &Path, backend: Backend) -> Result<(LoadedModel, bool), String> {
    let build = |requested| {
        let model = Model::load_with(
            path,
            &ModelOptions {
                backend: requested,
                ..Default::default()
            },
        )
        .map_err(|error| format!("Could not load {}: {error}", path.display()))?;
        let capabilities = model
            .capabilities()
            .map_err(|error| format!("Could not read model capabilities: {error}"))?;
        let session = model
            .session()
            .map_err(|error| format!("Could not create an inference session: {error}"))?;
        Ok(LoadedModel {
            id: String::new(),
            path: path.to_path_buf(),
            model,
            session,
            capabilities,
            requested_backend: requested,
            backend_fallback: false,
        })
    };
    let mut loaded = match build(backend) {
        Ok(loaded) => loaded,
        Err(error) if !matches!(backend, Backend::Cpu | Backend::CpuAccel) => {
            build(Backend::Cpu)
                .map_err(|cpu_error| format!("{error}; CPU fallback failed: {cpu_error}"))?
        }
        Err(error) => return Err(error),
    };
    loaded.backend_fallback = is_cpu_backend(&loaded.model.backend())
        && !matches!(backend, Backend::Cpu | Backend::CpuAccel | Backend::Auto);
    let fallback = loaded.backend_fallback;
    Ok((loaded, fallback))
}

fn is_cpu_backend(name: &str) -> bool {
    name.eq_ignore_ascii_case("cpu")
}

fn should_fallback_to_cpu(error: &Error, active_backend: &str) -> bool {
    matches!(error, Error::OutOfMemory(_)) && !is_cpu_backend(active_backend)
}

fn run_batch_with_cpu_fallback(
    current: &mut Option<LoadedModel>,
    samples: &[f32],
    options: &RunOptions,
) -> Result<(Transcript, bool), String> {
    let loaded = current
        .as_mut()
        .ok_or_else(|| "Load a local model before transcribing.".to_string())?;
    let active_backend = loaded.model.backend();
    match loaded.session.run(samples, options) {
        Ok(transcript) => Ok((transcript, false)),
        Err(error) if should_fallback_to_cpu(&error, &active_backend) => {
            let id = loaded.id.clone();
            let path = loaded.path.clone();
            *current = None;
            let (mut cpu, _) = load_model_with_backend(&path, Backend::Cpu)
                .map_err(|cpu_error| format!("{error}; CPU fallback failed: {cpu_error}"))?;
            cpu.id = id;
            cpu.backend_fallback = true;
            let transcript = cpu
                .session
                .run(samples, options)
                .map_err(|cpu_error| format!("{error}; CPU retry failed: {cpu_error}"))?;
            *current = Some(cpu);
            Ok((transcript, true))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn load_model(
    current: &mut Option<LoadedModel>,
    model_id: &str,
    model_path: &str,
    preference: &str,
) -> Result<Value, String> {
    let path = PathBuf::from(model_path);
    let requested_backend = backend_for_preference(preference);
    if let Some(loaded) = current.as_ref() {
        if loaded.id == model_id
            && loaded.path == path
            && loaded.requested_backend == requested_backend
        {
            return Ok(model_info(loaded));
        }
    }

    *current = None;
    let (mut loaded, _) = load_model_with_backend(&path, requested_backend)?;
    loaded.id = model_id.to_string();
    let info = model_info(&loaded);
    *current = Some(loaded);
    Ok(info)
}

fn model_info(loaded: &LoadedModel) -> Value {
    json!({
        "modelId": loaded.id,
        "architecture": loaded.model.arch(),
        "variant": loaded.model.variant(),
        "backend": loaded.model.backend(),
        "capabilities": {
            "nativeSampleRate": loaded.capabilities.native_sample_rate,
            "languages": loaded.capabilities.languages,
            "languageDetection": loaded.capabilities.supports_language_detect,
            "maxAudioMs": loaded.capabilities.max_audio_ms
        },
        "backendFallback": loaded.backend_fallback
    })
}

fn audio_to_16khz(wav: &[u8]) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::new(std::io::Cursor::new(wav))
        .map_err(|error| format!("Could not read WAV audio: {error}"))?;
    let spec = reader.spec();
    if spec.channels != 1
        || spec.sample_format != hound::SampleFormat::Int
        || spec.bits_per_sample != 16
    {
        return Err("Local inference expects 16-bit mono PCM WAV audio.".to_string());
    }
    if spec.sample_rate == 0 {
        return Err("WAV audio has an invalid sample rate.".to_string());
    }
    let samples = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not decode WAV audio: {error}"))?;
    if samples.is_empty() {
        return Err("WAV audio contains no samples.".to_string());
    }

    resample_to_16khz(&samples, spec.sample_rate)
}

fn resample_to_16khz(samples: &[i16], sample_rate: u32) -> Result<Vec<f32>, String> {
    if samples.is_empty() {
        return Err("Audio contains no samples.".to_string());
    }
    if sample_rate == 0 {
        return Err("Audio has an invalid sample rate.".to_string());
    }
    let output_len = (samples.len() as u64 * 16_000 / u64::from(sample_rate)) as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source_position = index as f64 * f64::from(sample_rate) / 16_000.0;
        let left = (source_position.floor() as usize).min(samples.len() - 1);
        let right = (left + 1).min(samples.len() - 1);
        let fraction = (source_position - left as f64) as f32;
        let left_sample = f32::from(samples[left]) / 32768.0;
        let right_sample = f32::from(samples[right]) / 32768.0;
        output.push(left_sample + ((right_sample - left_sample) * fraction));
    }
    Ok(output)
}

fn handle_request(
    request: &Value,
    current: &mut Option<LoadedModel>,
) -> (Option<u64>, Result<Value, (String, String)>) {
    let id = request.get("id").and_then(Value::as_u64);
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = match command {
        "hardware-info" => {
            let devices = transcribe_cpp::devices();
            let backends = [
                ("cpu", Backend::Cpu),
                ("metal", Backend::Metal),
                ("vulkan", Backend::Vulkan),
                ("cuda", Backend::Cuda),
                ("rocm", Backend::Rocm),
            ]
            .into_iter()
            .map(|(name, backend)| json!({ "name": name, "available": transcribe_cpp::backend_available(backend) }))
            .collect::<Vec<_>>();
            Ok(json!({
                "devices": devices.iter().map(|device| json!({
                    "name": device.name,
                    "description": device.description,
                    "kind": device.kind,
                    "type": format!("{:?}", device.device_type).to_lowercase(),
                    "memoryTotal": device.memory_total,
                    "memoryFree": device.memory_free
                })).collect::<Vec<_>>(),
                "backends": backends
            }))
        }
        "load" => {
            let model_id = request
                .get("modelId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let model_path = request
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let preference = request
                .get("backend")
                .and_then(Value::as_str)
                .unwrap_or("auto");
            if model_id.is_empty() || model_path.is_empty() {
                Err((
                    "invalid_request".to_string(),
                    "load requires modelId and path.".to_string(),
                ))
            } else {
                load_model(current, model_id, model_path, preference)
                    .map_err(|message| ("model_load_failed".to_string(), message))
            }
        }
        "warm" => {
            if current.is_none() {
                return (
                    id,
                    Err((
                        "model_not_loaded".to_string(),
                        "Load a local model before warming it.".to_string(),
                    )),
                );
            }
            let silence = vec![0.0_f32; 16_000];
            let started = std::time::Instant::now();
            let (_, backend_fallback) =
                match run_batch_with_cpu_fallback(current, &silence, &RunOptions::default()) {
                    Ok(result) => result,
                    Err(error) => return (id, Err(("model_warmup_failed".to_string(), error))),
                };
            let backend = current
                .as_ref()
                .map(|loaded| loaded.model.backend())
                .unwrap_or_default();
            Ok(json!({
                "warmed": true,
                "durationMs": started.elapsed().as_millis(),
                "backend": backend,
                "backendFallback": backend_fallback
            }))
        }
        "transcribe" => {
            if current.is_none() {
                return (
                    id,
                    Err((
                        "model_not_loaded".to_string(),
                        "Load a local model before transcribing.".to_string(),
                    )),
                );
            }
            let encoded = request
                .get("wavBase64")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let wav = match base64::engine::general_purpose::STANDARD.decode(encoded) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return (
                        id,
                        Err((
                            "invalid_audio".to_string(),
                            format!("Could not decode WAV payload: {error}"),
                        )),
                    )
                }
            };
            let samples = match audio_to_16khz(&wav) {
                Ok(samples) => samples,
                Err(message) => return (id, Err(("invalid_audio".to_string(), message))),
            };
            let mut options = RunOptions::default();
            if let Some(language) = request.get("language").and_then(Value::as_str) {
                if !language.is_empty() && !language.eq_ignore_ascii_case("auto") {
                    options.language = Some(language.to_string());
                }
            }
            let started = std::time::Instant::now();
            let (transcript, backend_fallback) =
                match run_batch_with_cpu_fallback(current, &samples, &options) {
                    Ok(result) => result,
                    Err(error) => return (id, Err(("speech_inference_failed".to_string(), error))),
                };
            let backend = current
                .as_ref()
                .map(|loaded| loaded.model.backend())
                .unwrap_or_default();
            Ok(json!({
                "text": transcript.text.trim(),
                "language": transcript.language,
                "segments": transcript_segments_json(&transcript.segments),
                "durationMs": started.elapsed().as_millis(),
                "backend": backend,
                "backendFallback": backend_fallback
            }))
        }
        "unload" => {
            *current = None;
            Ok(json!({ "unloaded": true }))
        }
        _ => Err((
            "unknown_command".to_string(),
            format!("Unsupported speech worker command: {command}"),
        )),
    };
    (id, result)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    transcribe_cpp::init_logging();
    transcribe_cpp::init_backends_default()?;

    if std::env::args().nth(1).as_deref() == Some("--self-test") {
        let payload = json!({
            "ok": true,
            "engine": "transcribe-cpp",
            "protocol": 1,
            "streaming": false,
            "diarization": false
        });
        return write_message(&mut io::stdout().lock(), &payload).map_err(Into::into);
    }

    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut current: Option<LoadedModel> = None;
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_event(
                    &stdout,
                    &error_value(None, "invalid_json", error.to_string()),
                )?;
                continue;
            }
        };
        let (id, result) = handle_request(&request, &mut current);
        let response = match result {
            Ok(value) => success_value(id, value),
            Err((code, message)) => error_value(id, &code, message),
        };
        write_event(&stdout, &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        audio_to_16khz, backend_for_preference, handle_request, is_cpu_backend,
        should_fallback_to_cpu, transcript_segments_json,
    };
    use hound::{SampleFormat, WavSpec, WavWriter};
    use transcribe_cpp::Backend;

    fn wav(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let spec = WavSpec {
                channels,
                sample_rate,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            };
            let mut writer = WavWriter::new(std::io::Cursor::new(&mut bytes), spec).unwrap();
            for sample in samples {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        bytes
    }

    #[test]
    fn backend_preference_maps_auto_cpu_and_platform_gpu() {
        assert_eq!(backend_for_preference("auto"), Backend::Auto);
        assert_eq!(backend_for_preference("cpu"), Backend::Cpu);
        #[cfg(target_os = "macos")]
        assert_eq!(backend_for_preference("gpu"), Backend::Metal);
        #[cfg(not(target_os = "macos"))]
        assert_eq!(backend_for_preference("gpu"), Backend::Vulkan);
        assert_eq!(backend_for_preference("metal"), Backend::Metal);
        assert_eq!(backend_for_preference("vulkan"), Backend::Vulkan);
        assert_eq!(backend_for_preference("cuda"), Backend::Cuda);
        assert_eq!(backend_for_preference("rocm"), Backend::Rocm);
    }

    #[test]
    fn transcription_segments_keep_timing_and_text() {
        let segments = vec![transcribe_cpp::Segment {
            t0_ms: 100,
            t1_ms: 900,
            text: "Hello".to_string(),
            ..Default::default()
        }];
        let json = transcript_segments_json(&segments);
        assert_eq!(json[0]["t0Ms"], 100);
        assert_eq!(json[0]["t1Ms"], 900);
        assert_eq!(json[0]["text"], "Hello");
    }

    #[test]
    fn only_gpu_out_of_memory_triggers_cpu_fallback() {
        assert!(is_cpu_backend("CPU"));
        assert!(is_cpu_backend("cpu"));
        assert!(!is_cpu_backend("MTL0"));
        assert!(should_fallback_to_cpu(
            &transcribe_cpp::Error::OutOfMemory("device full".to_string()),
            "mtl0"
        ));
        assert!(!should_fallback_to_cpu(
            &transcribe_cpp::Error::OutOfMemory("device full".to_string()),
            "cpu"
        ));
        assert!(!should_fallback_to_cpu(
            &transcribe_cpp::Error::Backend("device lost".to_string()),
            "mtl0"
        ));
    }

    #[test]
    fn unavailable_gpu_load_attempts_cpu_fallback() {
        let error = match super::load_model_with_backend(
            std::path::Path::new("/definitely-missing-volyx-model.gguf"),
            Backend::Vulkan,
        ) {
            Ok(_) => panic!("a missing model must not load"),
            Err(error) => error,
        };
        assert!(error.contains("CPU fallback failed"), "{error}");
    }

    #[test]
    fn batch_transcription_requires_a_loaded_model() {
        let request = serde_json::json!({ "id": 1, "command": "transcribe" });
        let mut current = None;
        let (id, result) = handle_request(&request, &mut current);
        assert_eq!(id, Some(1));
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "model_not_loaded");
    }

    #[test]
    fn unknown_commands_are_rejected() {
        let request = serde_json::json!({ "id": 2, "command": "not-a-command" });
        let mut current = None;
        let (_, result) = handle_request(&request, &mut current);
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "unknown_command");
    }

    #[test]
    fn resamples_24khz_mono_pcm_to_16khz_float_samples() {
        let input: Vec<i16> = (0_i16..240).map(|sample| sample * 100).collect();
        let output = audio_to_16khz(&wav(&input, 24_000, 1)).unwrap();

        assert_eq!(output.len(), 160);
        assert!((output[10] - (1500.0 / 32768.0)).abs() < 0.00001);
    }

    #[test]
    fn rejects_non_mono_audio_and_empty_audio() {
        assert!(audio_to_16khz(&wav(&[1, 2], 24_000, 2)).is_err());
        assert!(audio_to_16khz(&wav(&[], 24_000, 1)).is_err());
    }
}
