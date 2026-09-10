const tableDefinitions = require('./tables');
const { runMigrations } = require('./migrations');
const { createIndexes } = require('./indexes');


function ensureSchema(db) {
  db.pragma('foreign_keys = ON');

  const setup = db.transaction(() => {
    /*
     * Create all base tables first.
     */
    db.exec(
      tableDefinitions.join('\n')
    );

    /*
     * Upgrade existing databases with missing columns.
     */
    runMigrations(db);

    /*
     * Create application indexes.
     */
    createIndexes(db);
  });

  setup();
}


module.exports = {
  ensureSchema
};