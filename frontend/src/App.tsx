import React, { useState, useRef, useEffect } from 'react';
import { signIn, signOut, getCurrentUser, isConfigured } from './auth';
import type { AuthUser } from './auth';
import { invokeAgentCoreDirect, isDirectCallConfigured } from './agentcore';
import './App.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface AppState {
  messages: Message[];
  input: string;
  isLoading: boolean;
  error: string | null;
  sessionId: string;
}

interface LoginState {
  email: string;
  password: string;
  isLoading: boolean;
  error: string | null;
}

const SUGGESTIONS = [
  'SQSの制限は？',
  'Lambdaのメモリ上限',
  'S3のオブジェクトサイズ',
];

// Generate a unique session ID
const generateSessionId = (): string => {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 15);
  return `session-${timestamp}-${randomPart}`;
};

// Get or create session ID from localStorage
const getOrCreateSessionId = (): string => {
  const stored = localStorage.getItem('agentcore-session-id');
  if (stored) return stored;
  const newId = generateSessionId();
  localStorage.setItem('agentcore-session-id', newId);
  return newId;
};

function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginState, setLoginState] = useState<LoginState>({
    email: '',
    password: '',
    isLoading: false,
    error: null
  });
  const [state, setState] = useState<AppState>(() => ({
    messages: [],
    input: '',
    isLoading: false,
    error: null,
    sessionId: getOrCreateSessionId()
  }));

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Check if Cognito is configured
  const cognitoEnabled = isConfigured();

  useEffect(() => {
    if (cognitoEnabled) {
      getCurrentUser().then(u => {
        setUser(u);
        setAuthChecked(true);
      });
    } else {
      setAuthChecked(true);
    }
  }, [cognitoEnabled]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [state.messages, state.isLoading]);

  const sendMessageDirect = async (
    message: string,
    history: Array<{role: string, content: string}>,
    assistantMessageId: string
  ): Promise<string> => {
    if (!user?.idToken) {
      throw new Error('Authentication required');
    }

    return await invokeAgentCoreDirect({
      message,
      history: history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
      idToken: user.idToken,
      actorId: user.email,
      sessionId: state.sessionId,
      onChunk: (chunk) => {
        setState(prev => ({
          ...prev,
          messages: prev.messages.map(msg =>
            msg.id === assistantMessageId ? { ...msg, content: chunk } : msg
          )
        }));
      }
    });
  };

  const handleError = (error: Error): string => {
    if (error.message.includes('Session expired')) {
      return error.message;
    }
    if (error.message.includes('502')) {
      return 'Agent Core is currently unavailable';
    }
    if (error.message.includes('504')) {
      return 'Request timed out, please try again';
    }
    if (error.message.includes('400')) {
      return 'Please enter a valid message';
    }
    if (error.message.includes('401')) {
      return 'Authentication required';
    }
    return 'Network error occurred';
  };

  const generateUUID = (): string => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const authUser = await signIn(loginState.email, loginState.password);
      setUser(authUser);
      setLoginState({ email: '', password: '', isLoading: false, error: null });
    } catch (err) {
      const error = err as Error;
      let message = 'Login failed';
      if (error.message.includes('Incorrect username or password')) {
        message = 'Incorrect email or password';
      } else if (error.message === 'NEW_PASSWORD_REQUIRED') {
        message = 'Password change required. Contact administrator.';
      }
      setLoginState(prev => ({ ...prev, isLoading: false, error: message }));
    }
  };

  const handleLogout = async () => {
    await signOut();
    setUser(null);
    const newSessionId = generateSessionId();
    localStorage.setItem('agentcore-session-id', newSessionId);
    setState({ messages: [], input: '', isLoading: false, error: null, sessionId: newSessionId });
  };

  const handleNewConversation = () => {
    const newSessionId = generateSessionId();
    localStorage.setItem('agentcore-session-id', newSessionId);
    setState(prev => ({
      ...prev,
      messages: [],
      error: null,
      sessionId: newSessionId
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const message = state.input.trim();
    if (!message || state.isLoading) return;

    await processMessage(message);
  };

  const processMessage = async (message: string) => {
    // AgentCore直接呼び出しが設定されているか確認
    if (!isDirectCallConfigured()) {
      setState(prev => ({
        ...prev,
        error: 'AgentCore is not configured. Please set environment variables.'
      }));
      return;
    }

    const userMessage: Message = {
      id: generateUUID(),
      role: 'user',
      content: message,
      timestamp: new Date()
    };

    const history = state.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    const assistantMessageId = generateUUID();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: new Date()
    };

    setState(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage, assistantMessage],
      input: '',
      isLoading: true,
      error: null
    }));

    try {
      const response = await sendMessageDirect(message, history, assistantMessageId);
      setState(prev => ({
        ...prev,
        messages: prev.messages.map(msg =>
          msg.id === assistantMessageId ? { ...msg, content: response } : msg
        ),
        isLoading: false
      }));
    } catch (error) {
      const errorMessage = handleError(error as Error);
      setState(prev => ({
        ...prev,
        messages: prev.messages.filter(m => m.id !== assistantMessageId),
        error: errorMessage,
        isLoading: false
      }));
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    if (state.isLoading) return;
    processMessage(suggestion);
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Show loading while checking auth
  if (!authChecked) {
    return (
      <div className="app">
        <div className="login-container">
          <div className="login-box">
            <div className="login-header">
              <div className="header-icon">🤖</div>
              <h1>Agent Core Demo</h1>
            </div>
            <p>Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  // Show login form if Cognito is enabled and user is not logged in
  if (cognitoEnabled && !user) {
    return (
      <div className="app">
        <div className="login-container">
          <div className="login-box">
            <div className="login-header">
              <div className="header-icon">🤖</div>
              <h1>Agent Core Demo</h1>
              <p>Sign in to continue</p>
            </div>
            <form onSubmit={handleLogin} className="login-form">
              <div className="form-group">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={loginState.email}
                  onChange={(e) => setLoginState(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="your@email.com"
                  disabled={loginState.isLoading}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={loginState.password}
                  onChange={(e) => setLoginState(prev => ({ ...prev, password: e.target.value }))}
                  placeholder="Password"
                  disabled={loginState.isLoading}
                  required
                />
              </div>
              {loginState.error && (
                <div className="login-error">{loginState.error}</div>
              )}
              <button type="submit" className="login-button" disabled={loginState.isLoading}>
                {loginState.isLoading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <div className="header-icon">🤖</div>
          <div className="header-text">
            <h1>Agent Core Demo</h1>
            <p>AWS サービスについて質問してください</p>
          </div>
        </div>
        <div className="header-controls">
          <button
            onClick={handleNewConversation}
            className="new-chat-button"
            disabled={state.isLoading || state.messages.length === 0}
            title="新しい会話を開始"
          >
            + 新しい会話
          </button>
          {user && (
            <div className="user-info">
              <span className="user-email">{user.email}</span>
              <button onClick={handleLogout} className="logout-button">Logout</button>
            </div>
          )}
        </div>
      </header>

      <main className="chat-container">
        <div className="messages">
          {state.messages.length === 0 && !state.isLoading && (
            <div className="empty-state">
              <div className="empty-icon">💬</div>
              <h2>こんにちは！</h2>
              <p>AWS サービスの制限やベストプラクティスについてお答えします</p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion, index) => (
                  <button
                    key={index}
                    className="suggestion-chip"
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {state.messages.map((message) => (
            <div key={message.id} className={`message ${message.role}`}>
              <div className="message-content">{message.content}</div>
              <div className="message-meta">
                <span className="message-role">
                  {message.role === 'user' ? 'You' : 'Agent'}
                </span>
                <span className="message-time">{formatTime(message.timestamp)}</span>
              </div>
            </div>
          ))}

          {state.isLoading && (
            <div className="message assistant loading">
              <div className="message-content">
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}

          {state.error && (
            <div className="error-message">
              <span className="error-icon">⚠️</span>
              {state.error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form onSubmit={handleSubmit} className="input-form">
          <div className="input-wrapper">
            <input
              type="text"
              value={state.input}
              onChange={(e) => setState(prev => ({ ...prev, input: e.target.value }))}
              placeholder="メッセージを入力..."
              disabled={state.isLoading}
              maxLength={1000}
            />
            <button type="submit" disabled={state.isLoading || !state.input.trim()}>
              送信
            </button>
          </div>
          <p className="input-hint">AgentCore Direct API (Streaming)</p>
        </form>
      </main>
    </div>
  );
}

export default App;
