const CURRENCY_DECIMALS = { BHD: 3, OMR: 3, KWD: 3, QAR: 2, SAR: 2 };

function getCurrencyDecimals(code) {
  return CURRENCY_DECIMALS[code] ?? 2;
}

module.exports = { getCurrencyDecimals };
