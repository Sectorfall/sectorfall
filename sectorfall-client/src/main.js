// Build Version: 1.0.1 - Fresh Entrypoint Rebuild
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App.js';
import { GameStateProvider } from './state/GameState.js';

// Global Platform Event Guard
// Catches and silences internal playground gateway polling 404s/Canceled promises
window.addEventListener('unhandledrejection', (event) => {
    const errorString = String(event.reason);
    if (errorString.includes('Canceled: Canceled') || errorString.includes('status')) {
        // Prevent the error from showing up as an uncaught exception
        event.preventDefault();
        console.debug('[Platform Service] Gateway Polling Interrupted (404/Canceled)');
    }
});

ReactDOM.render(
    React.createElement(GameStateProvider, null, 
        React.createElement(App)
    ), 
    document.getElementById('root')
);
