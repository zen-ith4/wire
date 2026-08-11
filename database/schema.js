const tableDefinitions = require('./tables');
const { runMigrations } = require('./migrations');
const { createIndexes } = require('./indexes');

function ensureSchema(db) {

  db.pragma("foreign_keys = ON");

  const setup = db.transaction(() => {

    db.exec(
      tableDefinitions.join('\n')
    );

    runMigrations(db);

    createIndexes(db);

  });

  setup();
}

module.exports = {
  ensureSchema
};