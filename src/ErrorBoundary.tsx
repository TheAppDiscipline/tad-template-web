import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Discipline Loop ErrorBoundary — catches React render errors and shows the error UI state
 * instead of a blank screen. Wrap the app root (or individual sections) with this.
 *
 * Replace the default fallback with your app's error UI once Slice 0 is done.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Replace with your error tracking service (e.g. Sentry) when PROFILE=PROD
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback

      return (
        <main className="app-shell" data-state="error">
          <section className="panel hero">
            <p className="eyebrow" style={{ color: 'var(--color-error)' }}>Error</p>
            <h1>Something went wrong.</h1>
            <p className="hero-copy">{this.state.error.message}</p>
            <button onClick={this.handleRetry} style={{ marginTop: 'var(--space-4)' }}>
              Try again
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}
