const { setupDmSocket } = require('./dm.socket');
const { setupGroupSocket } = require('./group.socket');

function setupSockets(io, socket) {
  setupDmSocket(io, socket);
  setupGroupSocket(io, socket);
}

module.exports = {
  setupSockets,
};