use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use base64::Engine;
use serde_json::{json, Value};
use transcribe_cpp::{
    Backend, Capabilities, Error, Model, ModelOptions, RunOptions, Session, StreamOptions,
    Transcript, VadOptions, VadSession,
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

enum StreamCommand {
    Feed(Vec<f32>),
    Boundary,
    Finish,
    Cancel,
}

struct ActiveStream {
    sender: SyncSender<StreamCommand>,
    thread: JoinHandle<()>,
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
            "maxAudioMs": loaded.capabilities.max_audio_ms,
            "streaming": loaded.capabilities.supports_streaming
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

fn pcm16_base64_to_16khz(encoded: &str, sample_rate: u32) -> Result<Vec<f32>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Could not decode PCM payload: {error}"))?;
    if bytes.len() % 2 != 0 {
        return Err("PCM payload must contain complete 16-bit samples.".to_string());
    }
    let samples = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    resample_to_16khz(&samples, sample_rate)
}

fn request_sample_rate(request: &Value) -> u32 {
    request
        .get("sampleRate")
        .and_then(Value::as_u64)
        .filter(|rate| *rate > 0 && *rate <= 384_000)
        .unwrap_or(24_000) as u32
}

fn request_pcm_base64(request: &Value) -> &str {
    request
        .get("audio")
        .or_else(|| request.get("pcm16Base64"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn load_vad_session(path: &str, preference: &str) -> Result<VadSession, String> {
    let backend = match preference {
        "" | "auto" => Backend::Cpu,
        other => backend_for_preference(other),
    };
    Model::load_with(
        PathBuf::from(path),
        &ModelOptions {
            backend,
            ..Default::default()
        },
    )
    .and_then(|model| model.vad_session())
    .map_err(|error| error.to_string())
}

fn emit_stream_event(
    output: &Arc<Mutex<io::Stdout>>,
    channel: &str,
    event_type: &str,
    value: Value,
) -> io::Result<()> {
    write_event(
        output,
        &json!({
            "event": true,
            "type": event_type,
            "channel": channel,
            "data": value
        }),
    )
}

fn run_stream_thread(
    loaded: LoadedModel,
    channel: String,
    language: String,
    receiver: Receiver<StreamCommand>,
    ready: SyncSender<Result<Value, String>>,
    output: Arc<Mutex<io::Stdout>>,
) {
    if !loaded.capabilities.supports_streaming {
        let _ = ready.send(Err(format!(
            "{} does not support native streaming.",
            loaded.id
        )));
        return;
    }

    let info = model_info(&loaded);
    let mut session = loaded.session;
    let mut run_options = RunOptions::default();
    if !language.is_empty() && !language.eq_ignore_ascii_case("auto") {
        run_options.language = Some(language.clone());
    }
    let warmup = vec![0.0_f32; 8_000];
    if let Err(error) = session.run(&warmup, &run_options) {
        let _ = ready.send(Err(format!(
            "Could not warm speech model before streaming: {error}"
        )));
        return;
    }
    let mut stream = match session.stream(&run_options, &StreamOptions::default()) {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready.send(Err(format!("Could not start speech stream: {error}")));
            return;
        }
    };
    if ready.send(Ok(info)).is_err() {
        return;
    }

    while let Ok(command) = receiver.recv() {
        match command {
            StreamCommand::Feed(samples) => match stream.feed(&samples) {
                Ok(update) => {
                    if update.result_changed {
                        let text = stream.text();
                        let _ = emit_stream_event(
                            &output,
                            &channel,
                            "speech.partial",
                            json!({
                                "full": text.full,
                                "committed": text.committed,
                                "tentative": text.tentative,
                                "revision": update.revision,
                                "inputReceivedMs": update.input_received_ms
                            }),
                        );
                    }
                }
                Err(error) => {
                    let _ = emit_stream_event(
                        &output,
                        &channel,
                        "speech.error",
                        json!({ "code": "speech_stream_feed_failed", "message": error.to_string() }),
                    );
                    return;
                }
            },
            StreamCommand::Boundary => {
                match stream.finalize() {
                    Ok(update) => {
                        let text = stream.text();
                        let _ = emit_stream_event(
                            &output,
                            &channel,
                            "speech.final",
                            json!({
                                "text": text.full,
                                "revision": update.revision,
                                "inputReceivedMs": update.input_received_ms
                            }),
                        );
                    }
                    Err(error) => {
                        let _ = emit_stream_event(
                            &output,
                            &channel,
                            "speech.error",
                            json!({ "code": "speech_stream_finalize_failed", "message": error.to_string() }),
                        );
                        return;
                    }
                }
                drop(stream);
                stream = match session.stream(&run_options, &StreamOptions::default()) {
                    Ok(stream) => stream,
                    Err(error) => {
                        let _ = emit_stream_event(
                            &output,
                            &channel,
                            "speech.error",
                            json!({ "code": "speech_stream_restart_failed", "message": error.to_string() }),
                        );
                        return;
                    }
                };
            }
            StreamCommand::Finish => {
                match stream.finalize() {
                    Ok(update) => {
                        let text = stream.text();
                        let _ = emit_stream_event(
                            &output,
                            &channel,
                            "speech.final",
                            json!({
                                "text": text.full,
                                "revision": update.revision,
                                "inputReceivedMs": update.input_received_ms
                            }),
                        );
                    }
                    Err(error) => {
                        let _ = emit_stream_event(
                            &output,
                            &channel,
                            "speech.error",
                            json!({ "code": "speech_stream_finalize_failed", "message": error.to_string() }),
                        );
                    }
                }
                return;
            }
            StreamCommand::Cancel => {
                stream.reset();
                let _ = emit_stream_event(&output, &channel, "speech.canceled", json!({}));
                return;
            }
        }
    }
}

fn end_stream(stream: ActiveStream, command: StreamCommand) -> Result<(), String> {
    let send_error = stream
        .sender
        .send(command)
        .err()
        .map(|error| format!("Could not stop speech stream: {error}"));
    let join_error = stream
        .thread
        .join()
        .err()
        .map(|_| "Speech stream worker thread failed.".to_string());
    match (send_error, join_error) {
        (Some(send_error), Some(join_error)) => Err(format!("{send_error} {join_error}")),
        (Some(error), None) | (None, Some(error)) => Err(error),
        (None, None) => Ok(()),
    }
}

fn command_name(request: &Value) -> &str {
    request
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn handle_request(
    request: &Value,
    current: &mut Option<LoadedModel>,
    streams: &mut HashMap<String, ActiveStream>,
    vad: &mut Option<VadSession>,
    output: Arc<Mutex<io::Stdout>>,
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
        "vad-load" => {
            let path = request
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let preference = request
                .get("backend")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if path.is_empty() {
                Err((
                    "invalid_request".to_string(),
                    "vad-load requires path.".to_string(),
                ))
            } else {
                load_vad_session(path, preference)
                    .map(|session| {
                        *vad = Some(session);
                        json!({ "loaded": true })
                    })
                    .map_err(|error| ("speech_vad_load_failed".to_string(), error))
            }
        }
        "vad-detect" => {
            let threshold = request
                .get("threshold")
                .and_then(Value::as_f64)
                .unwrap_or(0.4)
                .clamp(0.01, 0.99);
            let min_speech_ms = request
                .get("minSpeechMs")
                .and_then(Value::as_i64)
                .unwrap_or(160)
                .clamp(0, 2000) as i32;
            if vad.is_none() {
                let path = request
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if path.is_empty() {
                    return (
                        id,
                        Err((
                            "speech_vad_not_loaded".to_string(),
                            "Load the speech detector before detecting speech.".to_string(),
                        )),
                    );
                }
                let preference = request
                    .get("backend")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match load_vad_session(path, preference) {
                    Ok(session) => *vad = Some(session),
                    Err(error) => {
                        return (id, Err(("speech_vad_load_failed".to_string(), error)));
                    }
                }
            }
            let session = vad.as_mut().expect("loaded above");
            let sample_rate = request_sample_rate(request);
            let samples = match pcm16_base64_to_16khz(request_pcm_base64(request), sample_rate) {
                Ok(samples) => samples,
                Err(message) => return (id, Err(("invalid_audio".to_string(), message))),
            };
            session
                .run(
                    &samples,
                    &VadOptions {
                        threshold,
                        min_speech_ms,
                        ..Default::default()
                    },
                )
                .map(|result| {
                    json!({
                        "speech": !result.segments.is_empty(),
                        "segmentCount": result.segments.len(),
                        "segments": result.segments.iter().map(|segment| json!({
                            "startSample": segment.start_sample,
                            "endSample": segment.end_sample
                        })).collect::<Vec<_>>()
                    })
                })
                .map_err(|error| ("speech_vad_failed".to_string(), error.to_string()))
        }
        "vad-unload" => {
            *vad = None;
            Ok(json!({ "unloaded": true }))
        }
        "load" => {
            if !streams.is_empty() {
                return (
                    id,
                    Err((
                        "speech_model_busy".to_string(),
                        "Finish active streams before loading another model.".to_string(),
                    )),
                );
            }
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
            let mut stop_errors = Vec::new();
            for (_, stream) in streams.drain() {
                if let Err(message) = end_stream(stream, StreamCommand::Cancel) {
                    stop_errors.push(message);
                }
            }
            if !stop_errors.is_empty() {
                return (
                    id,
                    Err((
                        "speech_stream_stop_failed".to_string(),
                        stop_errors.join(" "),
                    )),
                );
            }
            Ok(json!({ "unloaded": true }))
        }
        "stream-start" => {
            let model_id = request
                .get("modelId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let model_path = request
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let channel = request
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let language = request
                .get("language")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let preference = request
                .get("backend")
                .and_then(Value::as_str)
                .unwrap_or("auto");
            if model_id.is_empty() || model_path.is_empty() || !matches!(channel, "you" | "them") {
                return (
                    id,
                    Err((
                        "invalid_request".to_string(),
                        "stream-start requires modelId, path, and a valid channel.".to_string(),
                    )),
                );
            }
            if streams.contains_key(channel) {
                return (
                    id,
                    Err((
                        "speech_stream_already_started".to_string(),
                        format!("A stream is already active for {channel}."),
                    )),
                );
            }
            let path = PathBuf::from(model_path);
            let requested_backend = backend_for_preference(preference);
            let loaded = if current.as_ref().is_some_and(|loaded| {
                loaded.id == model_id
                    && loaded.path == path
                    && loaded.requested_backend == requested_backend
            }) {
                current.take().expect("checked above")
            } else {
                *current = None;
                let (mut loaded, _) = match load_model_with_backend(&path, requested_backend) {
                    Ok(loaded) => loaded,
                    Err(error) => return (id, Err(("model_load_failed".to_string(), error))),
                };
                loaded.id = model_id.to_string();
                loaded
            };
            let (sender, receiver) = mpsc::sync_channel(4);
            let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
            let thread_output = Arc::clone(&output);
            let channel_name = channel.to_string();
            let worker = thread::spawn(move || {
                run_stream_thread(
                    loaded,
                    channel_name,
                    language,
                    receiver,
                    ready_sender,
                    thread_output,
                );
            });
            match ready_receiver.recv() {
                Ok(Ok(info)) => {
                    streams.insert(
                        channel.to_string(),
                        ActiveStream {
                            sender,
                            thread: worker,
                        },
                    );
                    Ok(info)
                }
                Ok(Err(message)) => {
                    let _ = worker.join();
                    Err(("speech_stream_unavailable".to_string(), message))
                }
                Err(error) => {
                    let _ = worker.join();
                    Err(("speech_stream_start_failed".to_string(), error.to_string()))
                }
            }
        }
        "stream-feed" => {
            let channel = request
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(stream) = streams.get(channel) else {
                return (
                    id,
                    Err((
                        "speech_stream_not_started".to_string(),
                        format!("No active speech stream for {channel}."),
                    )),
                );
            };
            let sample_rate = request_sample_rate(request);
            let samples = match pcm16_base64_to_16khz(request_pcm_base64(request), sample_rate) {
                Ok(samples) => samples,
                Err(message) => return (id, Err(("invalid_audio".to_string(), message))),
            };
            match stream.sender.try_send(StreamCommand::Feed(samples)) {
                Ok(()) => Ok(json!({ "queued": true })),
                Err(TrySendError::Full(_)) => Err((
                    "speech_stream_backpressure".to_string(),
                    format!("The local {channel} stream could not keep up with audio input."),
                )),
                Err(TrySendError::Disconnected(_)) => Err((
                    "speech_stream_failed".to_string(),
                    format!("The local {channel} stream is no longer available."),
                )),
            }
        }
        "stream-boundary" => {
            let channel = request
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(stream) = streams.get(channel) else {
                return (
                    id,
                    Err((
                        "speech_stream_not_started".to_string(),
                        format!("No active speech stream for {channel}."),
                    )),
                );
            };
            stream
                .sender
                .try_send(StreamCommand::Boundary)
                .map(|_| json!({ "queued": true }))
                .map_err(|error| match error {
                    TrySendError::Full(_) => (
                        "speech_stream_backpressure".to_string(),
                        format!("The local {channel} stream could not keep up with audio input."),
                    ),
                    TrySendError::Disconnected(_) => (
                        "speech_stream_failed".to_string(),
                        format!("The local {channel} stream is no longer available."),
                    ),
                })
        }
        "stream-finish" | "stream-cancel" => {
            let channel = request
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(stream) = streams.remove(channel) else {
                return (
                    id,
                    Err((
                        "speech_stream_not_started".to_string(),
                        format!("No active speech stream for {channel}."),
                    )),
                );
            };
            let command = if command == "stream-finish" {
                StreamCommand::Finish
            } else {
                StreamCommand::Cancel
            };
            match end_stream(stream, command) {
                Ok(()) => Ok(json!({ "finished": command_name(request) == "stream-finish" })),
                Err(message) => Err(("speech_stream_stop_failed".to_string(), message)),
            }
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
            "streaming": true,
            "diarization": false
        });
        return write_message(&mut io::stdout().lock(), &payload).map_err(Into::into);
    }

    let stdin = io::stdin();
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut current: Option<LoadedModel> = None;
    let mut streams: HashMap<String, ActiveStream> = HashMap::new();
    let mut vad: Option<VadSession> = None;
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
        let (id, result) = handle_request(
            &request,
            &mut current,
            &mut streams,
            &mut vad,
            Arc::clone(&stdout),
        );
        let response = match result {
            Ok(value) => success_value(id, value),
            Err((code, message)) => error_value(id, &code, message),
        };
        write_event(&stdout, &response)?;
    }
    for (_, stream) in streams.drain() {
        end_stream(stream, StreamCommand::Cancel).map_err(io::Error::other)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        audio_to_16khz, backend_for_preference, handle_request, is_cpu_backend,
        pcm16_base64_to_16khz, should_fallback_to_cpu, transcript_segments_json,
    };
    use base64::Engine;
    use hound::{SampleFormat, WavSpec, WavWriter};
    use std::io;
    use std::sync::{Arc, Mutex};
    use transcribe_cpp::Backend;

    fn call(
        request: &serde_json::Value,
        current: &mut Option<super::LoadedModel>,
    ) -> (Option<u64>, Result<serde_json::Value, (String, String)>) {
        let mut streams = std::collections::HashMap::new();
        let mut vad = None;
        let output = Arc::new(Mutex::new(io::stdout()));
        handle_request(request, current, &mut streams, &mut vad, output)
    }

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
        let (id, result) = call(&request, &mut current);
        assert_eq!(id, Some(1));
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "model_not_loaded");
    }

    #[test]
    fn vad_detect_requires_a_loaded_detector() {
        let request = serde_json::json!({
            "id": 1,
            "command": "vad-detect",
            "pcm16Base64": ""
        });
        let mut current = None;
        let (_, result) = call(&request, &mut current);
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "speech_vad_not_loaded");
    }

    #[test]
    fn vad_load_requires_a_path() {
        let request = serde_json::json!({ "id": 1, "command": "vad-load" });
        let mut current = None;
        let (_, result) = call(&request, &mut current);
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "invalid_request");
    }

    #[test]
    fn vad_unload_reports_unloaded() {
        let request = serde_json::json!({ "id": 1, "command": "vad-unload" });
        let mut current = None;
        let (_, result) = call(&request, &mut current);
        assert_eq!(result.unwrap()["unloaded"], true);
    }

    #[test]
    fn stream_commands_require_an_active_stream() {
        let request = serde_json::json!({
            "id": 1,
            "command": "stream-feed",
            "channel": "you",
            "pcm16Base64": ""
        });
        let mut current = None;
        let (_, result) = call(&request, &mut current);
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "speech_stream_not_started");
    }

    #[test]
    fn stream_start_rejects_an_unknown_channel() {
        let request = serde_json::json!({
            "id": 1,
            "command": "stream-start",
            "modelId": "fake",
            "path": "/definitely-missing-volyx-model.gguf",
            "channel": "sideways"
        });
        let mut current = None;
        let (_, result) = call(&request, &mut current);
        let (code, _) = result.unwrap_err();
        assert_eq!(code, "invalid_request");
    }

    #[test]
    fn unknown_commands_are_rejected() {
        let request = serde_json::json!({ "id": 2, "command": "not-a-command" });
        let mut current = None;
        let (_, result) = call(&request, &mut current);
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

    #[test]
    fn decodes_stream_pcm_and_converts_24khz_to_16khz() {
        let pcm = [-16_384_i16, 0, 16_384, 32_767]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect::<Vec<_>>();
        let encoded = base64::engine::general_purpose::STANDARD.encode(pcm);

        let samples = pcm16_base64_to_16khz(&encoded, 24_000).unwrap();

        assert_eq!(samples.len(), 2);
        assert!((samples[0] + 0.5).abs() < 0.0001);
        assert!((samples[1] - 0.25).abs() < 0.0001);
    }

    #[test]
    fn rejects_odd_length_and_invalid_pcm_payloads() {
        assert!(pcm16_base64_to_16khz("AAAA", 24_000).is_err());
        assert!(pcm16_base64_to_16khz("not base64!", 24_000).is_err());
    }
}
