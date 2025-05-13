const EventEmitter = require('events');

// Initial application state
const initialState = {
    isLoggedIn: false,
    isRecording: false,
    statusMessage: 'Starting...',
    user: null,
    transcriptionStatus: null,
    currentMeeting: null,
    workspace: null,
};

let state = { ...initialState };

// Event emitter for state changes
const stateEmitter = new EventEmitter();

// Get current state
function getState() {
    return { ...state };
}

// Set new state and emit change event
function setState(newState) {
    const oldState = { ...state };
    state = { ...state, ...newState };
    stateEmitter.emit('change', { oldState, newState: { ...state } });
}

module.exports = {
    initialState,
    getState,
    setState,
    stateEmitter,
};
