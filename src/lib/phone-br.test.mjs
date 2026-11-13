// Validação de telefone do funil (public/inicio/js/phone-br.js) — precisa dar o
// MESMO veredito que o servidor (src/lib/pay-gateway.ts → beehivePhone), senão o
// cliente avança com um número que o gateway vai recusar com 422
// "customer.phone is invalid".
//
// Bug real de produção (20/10/2026): `55588888888` (DDD 55 + 888888888) passava
// na validação antiga (que só olhava o tamanho) e derrubava a venda.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../../public/inicio/js/phone-br.js", import.meta.url), "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(code, context);
const PhoneBR = context.window.PhoneBR;

test("phone-br normaliza para DDD + número (sem DDI)", () => {
  const cases = {
    "11999999999": "11999999999",
    "(11) 99999-9999": "11999999999",
    "+55 11 99999-9999": "11999999999",
    "5511999999999": "11999999999",
    "011999999999": "11999999999", // zero de discagem
    "1133334444": "1133334444", // fixo
    "55999999999": "55999999999", // DDD 55 + celular, não país 55
    "22984758475": "22984758475",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(PhoneBR.digits(input), expected, input);
    assert.ok(PhoneBR.isValid(input), `deveria ser válido: ${input}`);
    assert.equal(PhoneBR.e164(input), `+55${expected}`, input);
  }
});

test("phone-br recusa número impossível (casos do log de produção)", () => {
  const cases = [
    "55588888888", // DDD 55 + 888888888: celular tem de começar em 9
    "5555588888888",
    "20999999999", // DDD inexistente
    "30999999999",
    "1199999999", // celular sem o 9
    "113333444", // curto demais
    "119999999999", // longo demais
    "",
    "119", // telefone incompleto (log de 07:39)
  ];
  for (const input of cases) {
    assert.equal(PhoneBR.isValid(input), false, `não deveria ser válido: ${input}`);
    assert.equal(PhoneBR.e164(input), "", input);
    assert.ok(PhoneBR.reason(input).length > 0, `falta motivo: ${input}`);
  }
});

test("phone-br explica o motivo da recusa para o cliente", () => {
  assert.match(PhoneBR.reason("55588888888"), /começando com 9/);
  assert.match(PhoneBR.reason("20999999999"), /DDD 20 não existe/);
  assert.match(PhoneBR.reason("119"), /incompleto/);
});
