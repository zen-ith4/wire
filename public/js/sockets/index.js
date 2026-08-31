const { setupChatSocket } = require('./chat.socket');
const { setupDmSocket } = require('./dm.socket');

function setupSockets(io, socket) {
  setupChatSocket(io, socket);
  setupDmSocket(io, socket);
}

module.exports = {
  setupSockets,
};