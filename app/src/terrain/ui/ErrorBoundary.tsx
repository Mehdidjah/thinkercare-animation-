import {Component, type ReactNode} from 'react';

/** Last resort for a rendering error: a message and a reload instead of a blank page. */
export class ErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};

  static getDerivedStateFromError() {
    return {failed: true};
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="loading" role="alert" style={{padding: 24}}>
      <div className="wordmark">thinkercare<span>TERRAIN</span></div>
      <h1>Une erreur inattendue est survenue.</h1>
      <p>Rechargez la page pour reprendre. Les données déjà confirmées sont conservées.</p>
      <button className="primary" onClick={() => window.location.reload()}>Recharger</button>
    </div>;
  }
}
