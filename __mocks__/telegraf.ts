// __mocks__/sound-player.js

// Import this named export into your test file:
export const sendMessageMock = jest.fn();
const mock = jest.fn().mockImplementation(() => {
  return {
    startPolling: () => {},
    on: () => {},
    telegram: {
      sendMessage: sendMessageMock
    }
  };
});

export default mock;
