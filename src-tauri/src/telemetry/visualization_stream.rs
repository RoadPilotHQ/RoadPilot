//! Local, read-only WebSocket broadcaster for visualization frame v2.

use super::model::TelemetryUpdate;
use super::visualization::frame_from_update;
use futures_util::{SinkExt, StreamExt};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::header::ORIGIN;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};

pub const STREAM_PORT: u16 = 17_891;
const CHANNEL_CAPACITY: usize = 32;
const MAX_CLIENTS: usize = 4;

pub type UpdateBroadcaster = broadcast::Sender<TelemetryUpdate>;

pub fn broadcaster() -> UpdateBroadcaster {
    broadcast::channel(CHANNEL_CAPACITY).0
}

pub fn start(
    broadcaster: UpdateBroadcaster,
    latest: super::engine::SharedUpdate,
) -> JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = serve(broadcaster, latest).await {
            eprintln!("Visualization frame stream stopped: {error}");
        }
    })
}

async fn serve(
    broadcaster: UpdateBroadcaster,
    latest: super::engine::SharedUpdate,
) -> std::io::Result<()> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), STREAM_PORT);
    let listener = TcpListener::bind(address).await?;
    let permits = Arc::new(tokio::sync::Semaphore::new(MAX_CLIENTS));
    loop {
        let (stream, remote) = listener.accept().await?;
        if !remote.ip().is_loopback() {
            continue;
        }
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let receiver = broadcaster.subscribe();
        let latest = latest.clone();
        tauri::async_runtime::spawn(async move {
            let mut config = WebSocketConfig::default();
            config.max_message_size = Some(1024);
            config.max_frame_size = Some(1024);
            config.write_buffer_size = 1024;
            config.max_write_buffer_size = 64 * 1024;
            let accepted = tokio_tungstenite::accept_hdr_async_with_config(
                stream,
                |request: &Request, response: Response| {
                    if allowed_origin(request) {
                        Ok(response)
                    } else {
                        Err(Response::builder()
                            .status(403)
                            .body(Some("Origin not allowed".to_owned()))
                            .expect("valid rejection response"))
                    }
                },
                Some(config),
            )
            .await;
            let Ok(socket) = accepted else { return };
            serve_client(socket, receiver, latest).await;
            drop(permit);
        });
    }
}

fn allowed_origin(request: &Request) -> bool {
    let Some(origin) = request.headers().get(ORIGIN) else {
        // Non-browser clients on the same machine do not attach Origin.
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    matches!(
        origin,
        "http://127.0.0.1:5173"
            | "http://localhost:5173"
            | "http://127.0.0.1:4173"
            | "http://localhost:4173"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "tauri://localhost"
    )
}

async fn serve_client<S>(
    socket: tokio_tungstenite::WebSocketStream<S>,
    mut updates: broadcast::Receiver<TelemetryUpdate>,
    latest: super::engine::SharedUpdate,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut writer, mut reader) = socket.split();
    if let Some(frame) = latest_frame(&latest) {
        if send_frame(&mut writer, frame).await.is_err() {
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = reader.next() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                // The channel is display-only. A client message is never interpreted as a command.
                Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                    let _ = writer.send(Message::Close(None)).await;
                    break;
                }
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
            },
            received = updates.recv() => match received {
                Ok(update) => {
                    if let Some(frame) = frame_from_update(&update) {
                        if send_frame(&mut writer, frame).await.is_err() { break; }
                    } else {
                        // A missing live update closes the stream so the consumer marks its last
                        // frame stale instead of continuing to display it as current.
                        let _ = writer.send(Message::Close(None)).await;
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(frame) = latest_frame(&latest) {
                        if send_frame(&mut writer, frame).await.is_err() { break; }
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

fn latest_frame(
    latest: &super::engine::SharedUpdate,
) -> Option<super::visualization::VisualizationFrameV2> {
    let update = latest.lock().ok()?.clone();
    frame_from_update(&update)
}

async fn send_frame<W>(
    writer: &mut W,
    frame: super::visualization::VisualizationFrameV2,
) -> Result<(), tokio_tungstenite::tungstenite::Error>
where
    W: futures_util::Sink<Message> + Unpin,
    W::Error: Into<tokio_tungstenite::tungstenite::Error>,
{
    let json = serde_json::to_string(&frame).expect("visualization frame is serializable");
    writer
        .send(Message::Text(json.into()))
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_expected_browser_origins() {
        let allowed = Request::builder()
            .header(ORIGIN, "http://127.0.0.1:5173")
            .body(())
            .unwrap();
        let rejected = Request::builder()
            .header(ORIGIN, "https://example.com")
            .body(())
            .unwrap();
        assert!(allowed_origin(&allowed));
        assert!(!allowed_origin(&rejected));
    }

    #[test]
    fn permits_local_non_browser_clients_without_an_origin_header() {
        let request = Request::builder().body(()).unwrap();
        assert!(allowed_origin(&request));
    }
}
