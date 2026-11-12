#pragma once
// Constantes do protocolo OpenSpeak, compartilhadas por servidor e cliente.
// Os valores numéricos seguem os enums do cliente TeamSpeak 6
// (docs/ANALISE_TEAMSPEAK_P2P.md §3) e o cliente web (public/js/core/protocol.js).

#include <QString>
#include <QStringList>

namespace openspeak {

enum class StreamAccess : int { None = 0, Public = 1, ContactsOnly = 2, Private = 3 };
enum class StreamMode : int { None = 0, P2P = 1, SFU = 2 };
enum class StreamType : int { None = 0, Camera = 1, Screen = 2, Window = 3, ExistingSession = 4, File = 5, YouTube = 6 };
enum class LeaveReason : int {
    None = 0, Left = 1, Denied = 2, Failed = 3, Kicked = 4, Banned = 5, StreamStopped = 6, ViewerLimit = 7,
};

namespace rc {
inline const QString Ok = QStringLiteral("ok");
inline const QString InvalidArgs = QStringLiteral("invalid_args");
inline const QString NotLoggedIn = QStringLiteral("not_logged_in");
inline const QString UnknownCommand = QStringLiteral("unknown_command");
inline const QString StreamNotFound = QStringLiteral("stream_not_found");
inline const QString ClientNotFound = QStringLiteral("client_not_found");
inline const QString ChannelNotFound = QStringLiteral("channel_not_found");
inline const QString PermissionDenied = QStringLiteral("permission_denied");
inline const QString NotInChannel = QStringLiteral("not_in_channel");
inline const QString ModeNotSupported = QStringLiteral("mode_not_supported");
inline const QString StreamLimit = QStringLiteral("stream_limit");
inline const QString ViewerLimit = QStringLiteral("viewer_limit");
inline const QString Banned = QStringLiteral("banned");
inline const QString AlreadyJoined = QStringLiteral("already_joined");
inline const QString NoPendingRequest = QStringLiteral("no_pending_request");
inline const QString PayloadTooLarge = QStringLiteral("payload_too_large");
inline const QString Internal = QStringLiteral("internal_error");
inline const QString SessionExpired = QStringLiteral("session_expired");
inline const QString AccessDenied = QStringLiteral("access_denied");
inline const QString ProfilePassword = QStringLiteral("profile_password");
inline const QString ProfileLocked = QStringLiteral("profile_locked");
inline const QString ProfileRequired = QStringLiteral("profile_required");
} // namespace rc

// Extensões anunciadas em capabilityExtensions (TS: STREAM_P2P / STREAM_SFU).
inline const QString CapStreamP2P = QStringLiteral("STREAM_P2P");
inline const QString CapStreamSFU = QStringLiteral("STREAM_SFU"); // só com relay de mídia (servidor nativo)
/// O relay aceita duas camadas de vídeo do transmissor (mid "video-low") e a
/// escolha de qualidade do espectador (`streamsignaling` {type:'layer'}).
inline const QString CapStreamSimulcast = QStringLiteral("STREAM_SFU_SIMULCAST");
inline const QString CapStreamAnnotations = QStringLiteral("STREAM_ANNOTATIONS");
inline const QString CapStreamYouTube = QStringLiteral("STREAM_YOUTUBE");
inline constexpr int AnnotationScale = 10'000;
inline constexpr int MaxAnnotationPoints = 32;
inline constexpr int MaxAnnotationBatchesPerSecond = 24;
inline const QString CapProfiles = QStringLiteral("PROFILES");    // perfis guardados no servidor
inline const QString CapProfileMedia = QStringLiteral("PROFILE_MEDIA"); // banner baixado sob demanda

/// clid reservado do servidor como par WebRTC nos streams SFU (`streamsignaling`/`peerClid`).
constexpr int RelayClid = 0;

constexpr int MaxStreamsPerClient = 3;
constexpr int MaxThumbnailBytes = 256 * 1024;
constexpr int MaxSignalingBytes = 64 * 1024;
constexpr int MaxAvatarBytes = 64 * 1024;
// Banner e GIF da foto: cabem numa mensagem de sinalização junto com a capa da foto.
constexpr int MaxProfileMediaBytes = 440 * 1024;
/// Quanto uma sessão `resumable` espera a reconexão depois que a conexão cai.
constexpr int SessionGraceMs = 90'000;

} // namespace openspeak
