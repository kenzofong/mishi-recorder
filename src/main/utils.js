function withTimeout(promise, timeoutMs, operation) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]);
}

// Add other utility functions here as needed

module.exports = {
    withTimeout
};
