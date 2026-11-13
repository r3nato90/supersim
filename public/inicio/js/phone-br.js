/* Validação de telefone brasileiro no navegador — mesma regra do servidor
 * (src/lib/pay-gateway.ts → beehivePhone), para o cliente não avançar no funil
 * com um número que o gateway vai recusar.
 *
 * Regra:
 *   - celular: 9 dígitos começando em 9  (DDD + 9xxxxxxxx)
 *   - fixo:    8 dígitos começando em 2–5 (DDD + 2xxxxxxx … 5xxxxxxx)
 *   - DDD precisa existir (lista da ANATEL)
 *
 * Aceita máscara, `+55`, `55` na frente e zeros de discagem; devolve sempre os
 * dígitos locais (DDD + número), sem DDI.
 */
(function (global) {
  'use strict';

  // DDDs atribuídos no Brasil. Número com DDD inexistente (20, 26, 30, 39…)
  // é recusado pela Beehive com "customer.phone is invalid".
  var DDDS = {
    11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1,
    21: 1, 22: 1, 24: 1, 27: 1, 28: 1,
    31: 1, 32: 1, 33: 1, 34: 1, 35: 1, 37: 1, 38: 1,
    41: 1, 42: 1, 43: 1, 44: 1, 45: 1, 46: 1, 47: 1, 48: 1, 49: 1,
    51: 1, 53: 1, 54: 1, 55: 1,
    61: 1, 62: 1, 63: 1, 64: 1, 65: 1, 66: 1, 67: 1, 68: 1, 69: 1,
    71: 1, 73: 1, 74: 1, 75: 1, 77: 1, 79: 1,
    81: 1, 82: 1, 83: 1, 84: 1, 86: 1, 87: 1, 88: 1, 89: 1,
    91: 1, 92: 1, 93: 1, 94: 1, 95: 1, 96: 1, 97: 1, 98: 1, 99: 1,
  };

  /** Só os dígitos locais (DDD + número), sem DDI e sem zero de discagem. */
  function digits(value) {
    var d = String(value == null ? '' : value).replace(/\D/g, '').replace(/^0+/, '');
    // Código do país só é removido com 12/13 dígitos: `55999999999` é
    // DDD 55 + celular, não país 55.
    if (d.length > 11 && d.slice(0, 2) === '55') d = d.slice(2);
    return d;
  }

  /**
   * Motivo da recusa, ou '' quando o número é válido.
   * Mensagens já prontas para mostrar ao cliente.
   */
  function reason(value) {
    var d = digits(value);
    if (!d) return 'Informe seu telefone com DDD.';
    if (d.length < 10) return 'Telefone incompleto. Informe DDD + número.';
    if (d.length > 11) return 'Telefone com dígitos demais. Confira o número.';
    var ddd = d.slice(0, 2);
    var number = d.slice(2);
    if (!DDDS[ddd]) return 'DDD ' + ddd + ' não existe. Confira seu telefone.';
    if (d.length === 11 && !/^9\d{8}$/.test(number)) {
      return 'Celular deve ter 9 dígitos começando com 9.';
    }
    if (d.length === 10 && !/^[2-5]\d{7}$/.test(number)) {
      return 'Número inválido. Confira seu telefone.';
    }
    return '';
  }

  function isValid(value) {
    return reason(value) === '';
  }

  global.PhoneBR = {
    digits: digits,
    reason: reason,
    isValid: isValid,
    // Formato E.164 usado pelo gateway (`+5511999999999`); '' se inválido.
    e164: function (value) {
      return isValid(value) ? '+55' + digits(value) : '';
    },
  };
})(window);
