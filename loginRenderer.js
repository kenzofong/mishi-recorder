console.log('Login renderer script loaded.');

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const errorMessageElement = document.getElementById('error-message');
    const googleSignInButton = document.getElementById('google-signin');

    if (!loginForm) {
        console.error('Login form not found!');
        return;
    }
     if (!window.electronAPI) {
        console.error('Preload script did not run or expose electronAPI!');
        errorMessageElement.textContent = 'Error: Application integration failed. Cannot contact main process.';
        errorMessageElement.style.display = 'block';
        return;
    }

    // Handle regular email/password login
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = emailInput.value;
        const password = passwordInput.value;
        
        try {
            const result = await window.electronAPI.invokeLoginAttempt(email, password);
            if (result.success) {
                showSuccess('Login successful!');
                window.electronAPI.notifyLoginSuccess();
            } else {
                showError(result.error || 'Login failed');
            }
        } catch (error) {
            showError(error.message);
        }
    });

    // Handle Google Sign In
    googleSignInButton.addEventListener('click', async () => {
        try {
            showError(''); // Clear any existing error messages
            const result = await window.electronAPI.loginWithGoogle();
            if (result.success) {
                showSuccess('Login successful!');
                window.electronAPI.notifyLoginSuccess();
            } else {
                showError(result.error || 'Failed to sign in with Google');
            }
        } catch (error) {
            showError(error.message || 'Failed to sign in with Google');
        }
    });

    // Helper functions for displaying messages
    function showError(message) {
        errorMessageElement.textContent = message;
        errorMessageElement.className = message ? 'error' : '';
        errorMessageElement.style.display = message ? 'block' : 'none';
    }

    function showSuccess(message) {
        errorMessageElement.textContent = message;
        errorMessageElement.className = 'success';
        errorMessageElement.style.display = 'block';
        // Clear form
        loginForm.reset();
    }
}); 