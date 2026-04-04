import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "#ccc",
            gap: "16px",
            padding: "40px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "48px", opacity: 0.4 }}>&#x26A0;</div>
          <h2 style={{ margin: 0, fontSize: "18px", color: "#e0e0e0" }}>
            {this.props.title || "Something went wrong"}
          </h2>
          <p style={{ margin: 0, fontSize: "13px", opacity: 0.6, maxWidth: 400 }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "8px 20px",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "6px",
              color: "#e0e0e0",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
