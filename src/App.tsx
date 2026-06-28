import { BrowserRouter, Route, Routes } from 'react-router-dom'
import './App.css'
import { AppShellView } from './app-shell-view.js'
import { AUTH_MODE, BACKEND_PROVIDER } from './config/runtime'
import { ErrorBoundary } from './ErrorBoundary'

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          {/* Replace AppShellView with your app's pages in Slice 1+ */}
          <Route
            path="*"
            element={<AppShellView backendProvider={BACKEND_PROVIDER} authMode={AUTH_MODE} />}
          />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
