import { useEffect, useRef, useState } from "react";

// The app's one "are you sure?". askConfirm() opens it from anywhere and resolves
// to true or false; ConfirmHost, mounted once in App, draws it.
let openRequest = null;

export function askConfirm(request) {
  return new Promise((resolve) => {
    if (!openRequest) {
      resolve(false);
      return;
    }
    openRequest({ ...request, resolve });
  });
}

export function ConfirmHost() {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  const [request, setRequest] = useState(null);

  useEffect(() => {
    openRequest = (next) => {
      setRequest((current) => {
        current?.resolve(false);
        return next;
      });
    };
    return () => {
      openRequest = null;
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (request && !dialog.open) {
      dialog.showModal();
      // A destructive choice never starts focused, so Enter can't confirm it.
      if (!request.danger) confirmRef.current?.focus();
    } else if (!request && dialog.open) {
      dialog.close();
    }
  }, [request]);

  const answer = (value) => {
    request?.resolve(value);
    setRequest(null);
  };

  return (
    <dialog
      ref={dialogRef}
      className="lib-prompt confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        answer(false);
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) answer(false);
      }}
    >
      {request && (
        <div className="lib-prompt-panel">
          <h2 id="confirm-title" className="lib-prompt-title">{request.title}</h2>
          <p id="confirm-body" className="lib-prompt-body">{request.body}</p>
          {request.detail && <p className="confirm-detail" title={request.detail}>{request.detail}</p>}
          <div className="lib-prompt-actions">
            <button type="button" className="btn-quiet" onClick={() => answer(false)} autoFocus={Boolean(request.danger)}>
              Cancel
            </button>
            <button
              type="button"
              ref={confirmRef}
              className={request.danger ? "btn-quiet btn-danger" : "btn-primary"}
              onClick={() => answer(true)}
            >
              {request.confirmLabel || "OK"}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
