// Catálogo de produtos do funil SuperSim — fonte ÚNICA de preço (centavos).
// O navegador envia apenas o upKey; o valor real sempre vem daqui.
// Usado por sup-pix (criação da cobrança) e sup-utmify (venda paga).
// externalRef é o id estável do produto (aparece como `id` do produto na UTMify).

export type ProdutoSup = {
  amount: number;
  title: string;
  externalRef: string;
};

export const PRODUCTS: Record<string, ProdutoSup> = {
  seguro: { amount: 2863, title: "Guia de Alimentação Saudável", externalRef: "front" },
  up1: { amount: 2482, title: "Receitas Leves para o Dia a Dia", externalRef: "up1" },
  up2: { amount: 2391, title: "Cardápio Semanal Equilibrado", externalRef: "up2" },
  up3: { amount: 1868, title: "Guia de Sucos e Vitaminas", externalRef: "up3" },
  up4: { amount: 1720, title: "Receitas Saudáveis para o Jantar", externalRef: "up4" },
  up5: { amount: 1700, title: "Guia de Hábitos Saudáveis", externalRef: "up5" },
  up6: { amount: 1702, title: "Marmitas Saudáveis para a Semana", externalRef: "up6" },
  up7: { amount: 1406, title: "Guia de Chás e Infusões", externalRef: "up7" },
  up8: { amount: 1406, title: "Sobremesas Saudáveis e Leves", externalRef: "up8" },
  up9: { amount: 1199, title: "Guia de Reeducação Alimentar", externalRef: "up9" },
  up10: { amount: 1692, title: "Plano de Organização Alimentar", externalRef: "up10" },
  up11: { amount: 1953, title: "Manual de Rotina e Bem-Estar", externalRef: "up11" },
  up12: { amount: 3192, title: "Guia de Alimentação Diária", externalRef: "up12" },

  seguro_ds: { amount: 1432, title: "Guia de Alimentação Saudável", externalRef: "front_ds" },
  up1_ds: { amount: 1241, title: "Receitas Leves para o Dia a Dia", externalRef: "ds1" },
  up2_ds: { amount: 1196, title: "Cardápio Semanal Equilibrado", externalRef: "ds2" },
  up3_ds: { amount: 1000, title: "Guia de Sucos e Vitaminas", externalRef: "ds3" },
  up4_ds: { amount: 1000, title: "Receitas Saudáveis para o Jantar", externalRef: "ds4" },
  up5_ds: { amount: 1000, title: "Guia de Hábitos Saudáveis", externalRef: "ds5" },
  up6_ds: { amount: 1000, title: "Marmitas Saudáveis para a Semana", externalRef: "ds6" },
  up7_ds: { amount: 1000, title: "Guia de Chás e Infusões", externalRef: "ds7" },
  up8_ds: { amount: 1000, title: "Sobremesas Saudáveis e Leves", externalRef: "ds8" },
  up9_ds: { amount: 1000, title: "Guia de Reeducação Alimentar", externalRef: "ds9" },
  up10_ds: { amount: 1000, title: "Plano de Organização Alimentar", externalRef: "ds10" },
  up11_ds: { amount: 1000, title: "Manual de Rotina e Bem-Estar", externalRef: "ds11" },
  up12_ds: { amount: 1596, title: "Guia de Alimentação Diária", externalRef: "ds12" },
};
