function toISOString(date = new Date()) {
  return date.toISOString();
}

function nowISO() {
  return new Date().toISOString();
}

module.exports = {
  toISOString,
  nowISO,
};