"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calcularPuntaje = calcularPuntaje;
function calcularPuntaje(bet, result) {
    const betGlobal = bet.goles_local === bet.goles_visitante ? 'empate' : bet.goles_local > bet.goles_visitante ? 'local' : 'visitante';
    const resultGlobal = result.resultado_local === result.resultado_visitante ? 'empate' : result.resultado_local > result.resultado_visitante ? 'local' : 'visitante';
    const acerto_global = betGlobal === resultGlobal;
    const acerto_exacto_local = bet.goles_local === result.resultado_local;
    const acerto_exacto_visitante = bet.goles_visitante === result.resultado_visitante;
    const exactos_count = (acerto_exacto_local ? 1 : 0) + (acerto_exacto_visitante ? 1 : 0);
    const total_goles = result.resultado_local + result.resultado_visitante;
    // Verde: ganador correcto + exactamente 1 gol exacto de los dos.
    // Nota: en empate exactos_count es 0 o 2 (nunca 1), por eso empate nunca da verde.
    const diff_bet = bet.goles_local - bet.goles_visitante;
    const diff_result = result.resultado_local - result.resultado_visitante;
    const acerto_diferencia = diff_bet === diff_result;
    let puntos = 0;
    if (!acerto_global) {
        puntos = 0;
    }
    else if (exactos_count === 2) {
        puntos = 3;
    }
    else if (exactos_count === 1) {
        puntos = 2;
    }
    else {
        puntos = 1;
    }
    const bonus = acerto_global && exactos_count === 2 && total_goles >= 4;
    if (bonus) {
        puntos += 1;
    }
    return {
        puntos,
        bonus,
        detalle: {
            acerto_global,
            acerto_exacto_local,
            acerto_exacto_visitante,
            exactos_count,
            total_goles,
            acerto_diferencia,
        }
    };
}
//# sourceMappingURL=scoring.js.map