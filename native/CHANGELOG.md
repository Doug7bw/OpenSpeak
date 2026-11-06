# OpenSpeak 1.0.35 — qualidade por espectador

- **Simulcast no servidor:** quem transmite pelo app manda também uma versão
  mais leve do vídeo (até 480p), e cada espectador recebe a que a conexão dele
  aguenta. Uma pessoa com internet ruim não derruba mais a qualidade de todos.
- **Escolha de qualidade:** quem assiste pode deixar em **Automática** ou
  forçar **Alta** ou **Baixa**, pelo novo botão no vídeo (no app e no site).
- Quando a captura de janela fica preta, o app agora **pergunta** se você quer
  usar a captura alternativa (com a borda amarela), em vez de trocar sozinho.

# OpenSpeak 1.0.34 — versão mobile para assistir

- **Versão mobile do site:** no celular e no tablet, o site mostra quem está ao vivo
  e abre a transmissão em uma tela feita para assistir.
- A **barra de tarefas** com ocultação automática volta a aparecer ao levar o mouse
  à borda da tela com o app maximizado.

# OpenSpeak 1.0.33 — organizar em dois cliques

- **Organizar** agora alinha os previews mantendo o tamanho de cada um. Clique de
  novo para deixar todos do mesmo tamanho.

# OpenSpeak 1.0.32 — botões de organizar e desligar

- **Organizar automaticamente** agora é um ícone sempre à vista na barra inferior,
  que acende quando há previews fora da grade.
- **Desconectar** virou um ícone de desligar.

# OpenSpeak 1.0.31 — previews que se ajustam sozinhos

- Os **previews não se sobrepõem mais:** ao mover ou redimensionar um, os outros
  saem da frente e encolhem se faltar espaço.
- O **menu Iniciar e os atalhos** agora mostram o ícone novo.

# OpenSpeak 1.0.30 — previews livres e ícone transparente

- **Previews livres:** arraste um preview para qualquer lugar da área de streams e
  redimensione pelos cantos, no app e na versão web. O botão **Automático** volta
  tudo para a grade.
- Com o **tamanho dos previews** reduzido, eles ficam juntos e alinhados, em vez de
  espalhados pela área.
- O **ícone** agora tem os olhos coloridos e fundo transparente.

# OpenSpeak 1.0.29 — preview no picture-in-picture

- O **preview maior** agora some da grade enquanto o picture-in-picture está aberto,
  no app e na versão web, em vez de mostrar o vídeo duas vezes.

# OpenSpeak 1.0.28 — novidades ao atualizar e tamanho dos previews

- Depois de atualizar, o app abre uma janela com as **novidades da versão**, com a
  opção de mostrar todas as versões.
- **Tamanho dos previews:** ajuste em Exibição, na barra inferior da área de streams.
- A **prévia da sua transmissão** ganhou um botão para fechá-la de novo, sem precisar
  reiniciar a transmissão.
- Na **versão web**, a transmissão continua aparecendo na grade enquanto o
  picture-in-picture está aberto.

# OpenSpeak 1.0.27 — troca de fonte para a tela inteira

- Corrigido o erro **"Failed to duplicate IDXGIOutput1"** ao trocar a transmissão de
  uma janela para a tela inteira. As miniaturas do seletor também passam a funcionar
  durante a transmissão.
- Um **alt-tab** não joga mais a transmissão de janela para a captura com borda
  amarela: agora ela espera 3 segundos de tela preta antes de mudar.

# OpenSpeak 1.0.26 — GIF em loop, cursor na tela inteira e ícone na barra de tarefas

- A **foto e o banner em GIF** agora ficam em loop, em vez de parar depois da
  primeira volta.
- A foto em GIF e o banner voltaram a aparecer no **card de perfil** da lista de
  pessoas conectadas.
- A **transmissão de tela inteira** volta a mostrar o cursor do mouse.
- A **barra de tarefas** agora mostra o ícone novo, que acompanha o tema, no lugar
  do antigo. O instalador também avisa o Windows para trocar o ícone guardado.

# OpenSpeak 1.0.25 — ícone novo que acompanha o tema

- O OpenSpeak tem um **ícone novo**: uma TV de antenas com cara de brava.
- O ícone agora muda junto com o **tema e a cor de destaque**, na janela, na barra
  de tarefas e na bandeja, sem precisar reiniciar. O atalho e o instalador
  continuam com o ícone azul.

# OpenSpeak 1.0.24 — banner, GIF no perfil e aba Perfil renovada

- **Banner:** escolha uma imagem ou um GIF para aparecer atrás da sua foto no card
  de perfil.
- **Foto animada:** agora dá para usar um GIF de até 320 KB como foto. Na lista
  aparece o primeiro quadro; a animação toca no card, para a interface não pesar.
- **Preferências › Perfil** ganhou uma prévia do card e um aviso explicando que é
  preciso definir uma senha para personalizar o perfil.
- O **cursor do mouse** não some mais da transmissão de janela quando há um menu
  ou um overlay embaixo dele.
- O selo **AO VIVO** da lista de usuários ficou alinhado com a contagem de
  espectadores.

# OpenSpeak 1.0.23 — card de perfil e ajuste da foto

- Clique em alguém na lista para ver o **perfil**, com foto, descrição e o botão
  de contato.
- Ao escolher uma **foto**, agora dá para posicionar e dar zoom antes de aplicar.
- Os campos de senha ganharam um botão para **mostrar a senha**.
- Perdeu a senha do perfil? O administrador pode gerar uma nova, e você a troca
  depois em Preferências › Perfil.

# OpenSpeak 1.0.22 — perfis, cursor na transmissão e tela inicial mais simples

- **Perfis:** defina uma senha em Preferências › Perfil para reservar o seu
  apelido e personalizar foto, descrição, cor e nome de exibição. Sem senha,
  tudo continua como antes. Exige um servidor atualizado.
- A **transmissão de tela inteira** agora mostra o cursor do mouse.
- A **prévia da transmissão** fecha sozinha quando um app em tela cheia (jogo
  etc.) entra em foco, para economizar recursos. Um botão mostra a prévia de
  novo, e essa escolha vale até o fim da transmissão.
- A **tela inicial** ficou mais simples: o app já usa o servidor padrão, e o
  botão **Alterar servidor** mostra o campo de endereço.

# OpenSpeak 1.0.21 — tela cheia no monitor certo desde a primeira vez

- Corrigido: a **tela cheia** podia abrir no monitor principal na primeira vez
  que era aberta; agora abre no monitor onde está a janela do OpenSpeak já de
  primeira.

# OpenSpeak 1.0.20 — tela cheia no monitor certo

- A **tela cheia** abre no monitor onde está a janela do OpenSpeak, mesmo
  depois de mover a janela para outro monitor.
- Corrigido: a borda fina em volta da **tela cheia** podia aparecer clara;
  agora fica sempre preta.

# OpenSpeak 1.0.19 — sons do Nostalgia e ajustes de interface

- O tema de sons **Nostalgia** ganhou sons novos, mais próximos do clima dos
  avisos do Discord.
- O botão de **ouvir um tema** agora toca um som diferente a cada clique, para
  dar para conhecer todos os sons do tema.
- Corrigido: com as **Preferências** abertas não dava para redimensionar a
  janela pelas bordas.
- O destaque ao passar o mouse sobre as **pessoas do canal** ficou do tamanho
  da linha, alinhado com o nome e com cantos arredondados.

# OpenSpeak 1.0.18 — preferências novas, temas e mais sons

- As **Preferências** foram refeitas: abrem em tela cheia, com as categorias
  na lateral (Aparência, Sons, Streams assistidos, Windows, Atualizações e
  Licenças e créditos), no estilo das configurações do Discord.
- **Temas de cores**: Meia-noite, Grafite, Preto OLED, Ameixa, Floresta e um
  tema **Claro**, além de 8 **cores de destaque** à escolha (Preferências ›
  Aparência).
- **Seis temas de sons novos**: Cristal, Retrô, Kalimba, Espacial, Discreto e
  **Nostalgia**, uma paródia com o clima dos sons do Discord, criada do zero.
  Cada tema tem um botão para ouvir antes de escolher.
- **Atualizações** viraram uma página das Preferências, com a versão, o estado
  e as novidades no mesmo lugar. A escolha da edição Completa saiu dali.
- Nova página **Licenças e créditos**.
- Arrastar a janela até o **topo da tela** maximiza, e arrastar a janela
  maximizada pela barra de título restaura, como nos programas do Windows.
- O servidor tem agora **uma sala só, "Geral"**.
- O codificador de vídeo fica **sempre no automático** (saiu o menu ao lado de
  "Desconectar").
- Os controles deslizantes não mostram mais os tracinhos de escala.

# OpenSpeak 1.0.17 — pasta de instalação e volume com a roda do mouse

- Na primeira instalação dá para **escolher a pasta** onde o OpenSpeak fica.
  As atualizações continuam na mesma pasta, sem perguntar.
- O volume de cada transmissão agora muda com a **roda do mouse** e com as
  **setas do teclado**. Acima de 100% há uma pequena trava: arraste um pouco
  além ou insista na roda para passar.
- Corrigido: com a **senha do servidor errada**, a tela ficava em
  "Conectando…" para sempre. Agora o erro aparece e dá para tentar de novo.

# OpenSpeak 1.0.16 — servidor com senha

- A tela de entrada ganhou o campo **"Senha do servidor"**. Se o servidor for
  privado, digite a senha uma vez: o app lembra dela nas próximas vezes.
- O app **não vem mais com um servidor preenchido**: informe o endereço do
  servidor que você usa (quem já entrou antes continua com o endereço salvo).
- Quem hospeda o próprio servidor pode exigir uma senha com
  `OPENSPEAK_PASSWORD` e trocá-la a qualquer momento, sem reiniciar.

# OpenSpeak 1.0.15 — volume até 500% e barra de tarefas em tela cheia

- Nova opção **"Permitir aumentar o volume até 500%"** em Preferências ›
  Streams assistidos: o controle de volume de cada stream passa a ir além de
  100%, para transmissões com o som muito baixo. Ao arrastar, o valor aparece
  em porcentagem.
- Em **tela cheia**, se a barra de tarefas do Windows estiver configurada para
  se ocultar automaticamente, ela agora **aparece ao levar o mouse até a borda**
  da tela. Dá para desligar em Preferências › Streams assistidos.
- A tela de **Atualizações** agora mostra as **novidades da versão** e tem um
  atalho para ver todas.

# OpenSpeak 1.0.14 — quedas de internet pausam em vez de desconectar

- Se a sua internet cair ou parar de responder por alguns segundos, você
  **não sai mais da sala**: o app reconecta sozinho ("Reconectando…") e volta
  de onde parou, como no Discord.
- A sua transmissão **não acaba**: para quem assiste ela aparece **pausada**
  enquanto você está fora e volta sozinha quando a conexão retorna.
- O app percebe uma conexão morta em segundos, em vez de ficar travado
  esperando.
- Se a queda passar de 90 segundos, você sai da sala como antes.

# OpenSpeak 1.0.13 — transmissão de tela sem o áudio do Discord por padrão

- A opção **"Sem áudio do Discord"** agora vem **ligada por padrão** ao
  transmitir a tela: vozes e sons do Discord não vão para quem assiste.
  Quem já tinha desligado a opção antes continua com a escolha salva.
- Enquanto ela estiver ativa, as transmissões que você assiste ficam sem som
  durante a sua transmissão, para o áudio delas não vazar para a sua.
  Desligue a opção na tela de transmissão se quiser ouvir.

# OpenSpeak 1.0.12 — imagem sem pixels corrompidos quando a rede oscila

- Quando um pacote de vídeo se perde no caminho, o app agora **pede de novo
  só o pedaço que faltou**. Na maioria das vezes ele chega a tempo e você nem
  percebe a perda.
- Se o pedaço não chegar a tempo, o quadro quebrado **não é mostrado**: a
  imagem segura o último quadro bom por um instante e volta limpa no próximo
  quadro completo, em vez de mostrar blocos de pixels fora do lugar.
- No modo **Servidor** (SFU), o servidor também pede de volta o que se perdeu
  entre quem transmite e o servidor.

# OpenSpeak 1.0.11 — bot do Discord e janela mais fácil de usar

- **Bot do Discord**: o servidor pode avisar no Discord quem está ao vivo e
  qual app está transmitindo (status da call, mensagem num canal e status do
  bot), na hora em que a transmissão começa.
- Nova opção **"Mostrar ao vivo no bot do Discord"** nas configurações
  avançadas da transmissão (ligada por padrão). Desligue para a transmissão
  não aparecer no bot.
- Ao transmitir uma **janela**, o app informa o nome do programa (por exemplo
  "Counter-Strike 2" ou "Google Chrome"), que aparece no aviso do bot.
- Clicar no ícone do OpenSpeak na **barra de tarefas** agora minimiza o app.
- A janela de **picture-in-picture** pode ser redimensionada por qualquer
  borda ou canto, não só pelo canto inferior direito.

# OpenSpeak 1.0.10 — verificação de atualizações mais confiável

- Quando o GitHub limita as consultas da sua rede (60 por hora por IP), o app
  não mostra mais "Não foi possível verificar atualizações": ele consulta a
  página de releases e confere o instalador pelo arquivo `SHA256SUMS` publicado.
- Versões de teste e perfis de depuração não consultam mais o GitHub sozinhos,
  para não gastar o limite dividido com o app instalado.

# OpenSpeak 1.0.9 — quem assiste junto e novidades

- Quem está **assistindo** a uma transmissão também ouve o som quando alguém
  começa ou para de assistir, inclusive ao entrar e ao sair você mesmo.
- Passe o mouse sobre a contagem de espectadores de uma transmissão que você
  está assistindo para ver **quem está assistindo junto**.
- **Novidades** nas Preferências: veja o que mudou em cada versão.
- Depois de atualizar, o app avisa "OpenSpeak atualizado para a versão …" com
  um atalho para as novidades.
- Ícone de engrenagem das Preferências redesenhado (não fica mais achatado).

# OpenSpeak 1.0.8 — transmissão pelo servidor por padrão e quem está assistindo

- Novas transmissões começam no modo **Servidor** (SFU): o servidor repassa o
  vídeo para os espectadores, e o seu upload não cresce com cada pessoa assistindo.
- Em servidores sem relay de mídia (servidor web, tailnet e sala web) a
  transmissão cai sozinha para **P2P**, sem erro.
- Ainda dá para escolher **P2P** no diálogo de transmissão, e a escolha é lembrada.
- Passe o mouse sobre a contagem de espectadores da **sua** transmissão (na
  árvore de canais ou no quadro do stream) para ver **quem está assistindo**.
- Novo efeito sonoro quando alguém começa ou para de assistir à sua
  transmissão, nos estilos Suave e Bolha (mais discreto que os sons do canal).
- O selo ao lado do nome do servidor mostra **SFU** quando o servidor repassa as
  transmissões (antes mostrava sempre "P2P", mesmo com SFU disponível).
- Ícone de configurações agora é uma engrenagem.

# OpenSpeak 1.0.7 — efeitos sonoros e controles em tela cheia

- Efeitos sonoros ao entrar e sair do canal, quando alguém entra ou sai do seu
  canal e quando uma transmissão do canal começa, é pausada ou encerrada.
- Dois estilos: **Suave** (padrão) e **Bolha**. Escolha em **Preferências › Sons**,
  com prévia ao trocar e controle de volume.
- Para silenciar, desmarque **Tocar efeitos sonoros** nas Preferências ou use
  **Silenciar efeitos sonoros** no menu do ícone da bandeja.
- O cliente web ganhou os mesmos sons e opções em **Configurações**.
- Tela cheia com controles: ao mexer o mouse aparecem o nome do stream e os
  botões de pausar/retomar, parar, volume, sair do stream, picture-in-picture e
  sair da tela cheia. Eles somem, junto com o cursor, após 2,5 s parado.

# OpenSpeak 1.0.6 — bandeja do sistema

- Ícone na bandeja do Windows, como no Discord: o X esconde a janela e o
  OpenSpeak continua rodando, com transmissões e streams assistidos ativos.
- Clique no ícone para reabrir; com o botão direito: abrir, parar transmissão,
  silenciar streams assistidos, preferências e **Sair do OpenSpeak**.
- Nova tela de **Preferências**: minimizar para a bandeja ao fechar (ligado por
  padrão), iniciar com o Windows e iniciar minimizado na bandeja.
- Abrir o app de novo traz de volta a janela que está na bandeja, em vez de
  abrir uma segunda cópia.
- O picture-in-picture continua na tela quando o app é minimizado.

# OpenSpeak 1.0.5 — prévia de janelas minimizadas

- No seletor de fonte, janelas minimizadas mostram o último quadro, como no
  Alt+Tab, em vez de uma miniatura vazia ou só com a barra de título.

# OpenSpeak 1.0.4 — atualização visível

- A instalação automática mostra a barra de progresso em vez de rodar invisível.
  Antes, o app fechava e nada aparecia por uns 15 segundos até reabrir.
- Abrir o app durante a instalação mostra um aviso de que ele abrirá sozinho,
  em vez de fechar de novo ou disparar outra instalação.

# OpenSpeak 1.0.3 — edição lite e picture-in-picture

- Nova edição **Lite**, agora a padrão (`OpenSpeak-Setup.exe`): somente o cliente
  do servidor, com streams P2P direto ou pelo servidor (SFU). Não traz Tailscale,
  sala web nem servidor dedicado.
- A edição **Completa** continua disponível (`OpenSpeak-Full-Setup.exe`). Em
  Atualizações, escolha **Lite** ou **Completa**; a troca é instalada como
  atualização e preserva as configurações.
- Botão **Picture-in-picture** na barra de cada stream: abre uma janela pequena,
  sem borda, arrastável e redimensionável, no canto inferior direito da tela.
- Fixada por padrão por cima de todos os apps; o botão de alfinete alterna e a
  escolha fica salva.
- Controles ao passar o mouse: pausar/parar no seu stream, volume/sair nos outros.
  Duplo clique ou Esc voltam para a janela do app.

# OpenSpeak 1.0.2 — atualização automática ao abrir

- Verifica o canal selecionado em toda abertura, antes de conectar. Uma versão
  nova é baixada, validada pelo SHA-256 e instalada com reinício automático.
- Tela inicial mostra o estado da verificação e do download, sem pedir confirmação.
- Instalador por usuário em AppData, sem exigir administrador nas atualizações.
- Falhas na consulta ou no download liberam a entrada normalmente.
- A opção de verificação periódica controla somente as consultas a cada 6 horas.
  Atualizações encontradas durante o uso ficam para a próxima abertura.

# OpenSpeak 1.0.1 — conexão via servidor e ping

- Conexão via servidor é a opção principal na tela inicial. Tailscale e sala web
  ficam recolhidos dentro de **Avançado**, e só aparecem ao expandir.
- O ping de cada pessoa até o servidor aparece na lista de participantes no web
  e no Windows. Seu ping até o servidor também aparece na barra superior.
  Medição de RTT via ping/pong WebSocket; não é latência de mídia entre usuários.
- Botão de atualizações na barra da janela usa o ícone de download.

# OpenSpeak 1.0.0 — release estável

- Atualizações do app instalado pelas releases do GitHub: canal estável por padrão,
  com opção **Receber pré-releases**. Download automático em segundo plano,
  validação SHA-256 e instalação ao fechar o app. Não interrompe transmissões.
- Botão de atualizações na barra superior com versão, estado, verificação manual
  e aplicação com reinício. Configurações e identidade são preservadas.
- Link discreto no cliente web para o instalador da última release estável.
- Identificação de versão/sistema do app nativo no monitor, métricas individuais
  do SFU e correções das estatísticas SFU/P2P e dos controles em tela cheia no web.

# OpenSpeak nativo 0.2.7

- Modo **Servidor (SFU)**: o transmissor envia um fluxo só ao `openspeak-server`,
  que repassa o RTP (H.264 + Opus) a cada espectador sem transcodificar. O upload do
  transmissor deixa de crescer com o número de espectadores. Disponível quando o
  servidor anuncia `STREAM_SFU`; a malha da tailnet e a sala web continuam P2P.
- `openspeak-server`: `--rtc-port` (porta UDP única do relay, padrão 10000),
  `--public-ip` (IP anunciado atrás de NAT 1:1) e `--no-sfu`. Compila também em Linux
  (só o servidor, sem FFmpeg).
- Corrige a entrada em servidor dedicado: o endereço digitado era trocado pelo salvo
  (`ws://localhost:9988/ws`) ao clicar em Conectar.

# OpenSpeak nativo 0.2.6

- Opção "Sem áudio do Discord" na transmissão de tela: o áudio do app do Discord
  (estável, PTB ou Canary, com todos os processos filhos) fica fora da transmissão.
  O Discord é detectado a cada segundo; se abrir, fechar ou reiniciar, a captura é
  recriada sozinha. O Windows só exclui uma árvore de processos, então enquanto a opção
  estiver ativa as transmissões assistidas ficam sem som, para não vazarem para a sua.
  As estatísticas de áudio mostram o que está sendo capturado.

# OpenSpeak nativo 0.2.5

- Captura de janela sem a borda amarela do Windows.Graphics.Capture (Windows 10 não
  permite desligá-la). Janela visível e sem nada por cima: duplicação da tela (DXGI)
  recortada na GPU, no monitor com a maior parte da janela. Janela coberta:
  `PrintWindow(PW_RENDERFULLCONTENT)`. Preto nos dois modos por ~1 s volta para o
  `QWindowCapture` (com borda). Captura no fps alvo, cursor desenhado, janela
  minimizada reenvia o último quadro. `OPENSPEAK_WINDOW_CAPTURE=wgc` força o método antigo.
- As estatísticas da transmissão mostram o método de captura em uso.
- Licença AGPL-3.0-or-later; licenças das dependências vão em `licenses/` no pacote.

# OpenSpeak nativo 0.2.2

- Filtro de janelas baseado no HWND real: remove superfícies sem título, ocultas,
  cloaked, tool windows, popups internos e barras de tarefas. Janelas reais de
  Configurações continuam disponíveis.
- Miniaturas DWM seguem imediatamente a geometria dos ancestrais e as animações,
  acompanhando a rolagem com recorte no viewport. Teste verifica pixels no desktop.
- Portátil em um único executável, com ZIP embutido, extração automática no Temp
  e limpeza ao fechar. O launcher tem runtime estático e usa PowerShell do Windows
  para extrair; o app interno é o mesmo do instalador. Configurações ficam no perfil.
- `--local-test` no portátil inicia um servidor e dois perfis separados no mesmo PC.
- `--server-only` permite hospedar a sinalização privada com o mesmo portátil.
  O servidor aceita `--host` para escutar só no loopback atrás do Tailscale Serve.
- Cliente web publicado como entrada no Vercel: a sessão abre na origem HTTPS da
  tailnet, evitando acesso entre uma origem pública e a rede privada. Tailscale é
  obrigatório. Sem TURN nesta versão. Apps nativos conectados a servidores ts.net
  vinculam a mídia ao endereço do Tailscale, sem servidores STUN/TURN.

# OpenSpeak nativo 0.2.1

- Seleção de telas, janelas e câmeras em uma grade de cartões com miniaturas.
  Previews de janelas usam o compositor do Windows (DWM), inspirado apenas no preview
  do TailCast. Telas usam snapshots; câmeras e o fallback usam Qt Multimedia.
  Snapshots são atualizados ao abrir ou atualizar a lista; a fonte selecionada mostra
  vídeo ao vivo. Capturas indisponíveis recebem um aviso no cartão.
- Trocar fonte usa a mesma grade e preserva a transmissão e os espectadores.
  O preview local e a tela cheia acompanham a nova fonte.
  A seleção mantém a janela enumerada, mesmo se a ordem das janelas mudar.
  Uma janela fechada ou câmera desconectada não seleciona outra fonte por engano.
- Barra de título integrada ao tema, com controles de minimizar, maximizar/restaurar,
  fechar, arrastar e redimensionar. Ícone existente do OpenSpeak incluído no app,
  executável, atalhos e instalador.
- Rodapé do diálogo com as cores da interface; botões Cancelar e Ficar ao vivo
  alinhados à direita. Configurações com rolagem e controles de FPS ajustados à largura.
- Menu Exibição dimensionado para mostrar os textos completos.
- Testes para miniaturas, cancelamento da captura, fontes que desapareceram,
  troca de fonte com espectador conectado e layout QML em 900×560.

Artefatos gerados por `package.ps1`: instalador e ZIP portátil.
