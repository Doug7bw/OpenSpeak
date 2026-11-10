# Licenças de terceiros

O OpenSpeak é distribuído sob a **GNU Affero General Public License v3.0 ou posterior**
(veja [LICENSE](LICENSE)). Ele usa os componentes abaixo, cada um sob sua própria licença.
Na distribuição para Windows, os textos completos ficam na pasta `licenses/` ao lado do
executável.

## Cliente e servidor nativos (`native/`)

| Componente | Licença | Uso |
|---|---|---|
| [Qt 6](https://www.qt.io/) (Core, Gui, Widgets, Quick, QuickControls2, Multimedia, Network, WebSockets) | LGPL-3.0 | Interface, captura, rede. Carregado como DLLs substituíveis |
| [Qt HTTP Server](https://doc.qt.io/qt-6/qthttpserver-index.html) | GPL-3.0 | Servidor dedicado |
| [FFmpeg](https://ffmpeg.org/) (avcodec, swscale, swresample, avutil) | LGPL-2.1-or-later | Codificação/decodificação de vídeo e áudio |
| [libdatachannel](https://github.com/paullouisageneau/libdatachannel) | MPL-2.0 | WebRTC |
| [libjuice](https://github.com/paullouisageneau/libjuice) | MPL-2.0 | ICE |
| [libsrtp](https://github.com/cisco/libsrtp) | BSD-3-Clause | SRTP |
| [usrsctp](https://github.com/sctplab/usrsctp) | BSD-3-Clause | SCTP (data channels) |
| [OpenSSL](https://www.openssl.org/) | Apache-2.0 | DTLS/criptografia |
| [Opus](https://opus-codec.org/) | BSD-3-Clause | Codec de áudio |
| [OpenH264](https://www.openh264.org/) | BSD-2-Clause | Codec H.264 em software |
| [dav1d](https://code.videolan.org/videolan/dav1d) | BSD-2-Clause | Decodificador AV1 |
| [oneVPL](https://github.com/intel/libvpl) | MIT | Intel Quick Sync |
| [nv-codec-headers](https://github.com/FFmpeg/nv-codec-headers) | MIT | NVIDIA NVENC/NVDEC |
| [AMD AMF](https://github.com/GPUOpen-LibrariesAndSDKs/AMF) | MIT | AMD AMF |
| [nlohmann/json](https://github.com/nlohmann/json) | MIT | JSON |
| [plog](https://github.com/SergiusTheBest/plog) | MIT | Log |
| Microsoft Visual C++ Runtime | Licença redistribuível da Microsoft | Runtime do C++ |

O código-fonte do Qt e do FFmpeg nas versões usadas está disponível nos sites dos
projetos. As bibliotecas LGPL podem ser substituídas trocando as DLLs do Qt ou recompilando
o OpenSpeak a partir deste repositório.

## Servidor web (Node.js)

| Componente | Licença |
|---|---|
| [ws](https://github.com/websockets/ws) | MIT |
| [ioredis](https://github.com/redis/ioredis) | MIT |

## Bot do Discord (`discord-bot/`)

| Componente | Licença |
|---|---|
| [discord.js](https://github.com/discordjs/discord.js) (e dependências `@discordjs/*`) | Apache-2.0 |
| [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) (imagem das builds do Deadlock) | MIT |
| [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) (`discord-bot/assets/fonts`, texto da imagem) | SIL Open Font License 1.1 (`assets/fonts/OFL.txt`) |
| Dados de Deadlock: [deadlock-api.com](https://deadlock-api.com) (API pública, consultada em tempo real; nada é redistribuído) | — |
