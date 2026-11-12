#pragma once

// G-Sync desligado para o OpenSpeak.
//
// Com o G-Sync ligado também em janela, o driver NVIDIA trata o OpenSpeak como um
// jogo: o monitor passa a seguir os quadros da janela (a UI desenha só quando muda),
// a taxa de atualização despenca e a tela pisca ou o jogo ao lado engasga. O driver
// não tem chave em tempo de execução para isso; o jeito é o perfil de aplicativo
// (o mesmo do Painel de Controle NVIDIA > Programas), aqui com "G-SYNC: desligado".
//
// Fala com o nvapi64.dll do driver por nvapi_QueryInterface (sem SDK no build). Sem
// placa NVIDIA, ou sem permissão para gravar o perfil, não faz nada.

#include <QString>

namespace openspeak {

struct GsyncResult {
    enum Status { NoNvidia, AlreadyOff, TurnedOff, Failed };
    Status status = NoNvidia;
    QString detail; // para o log
};

/** Garante o perfil do executável atual com G-Sync desligado (bloqueia ~100–300 ms). */
GsyncResult disableGsyncForThisApp();

/** Roda disableGsyncForThisApp() numa thread à parte e registra o resultado no log. */
void disableGsyncInBackground();

} // namespace openspeak
