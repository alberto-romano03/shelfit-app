// Returns an AbortSignal that fires when the client disconnects before the
// response is finished. Threading this into the caching download loops lets the
// server stop hitting TMDB the moment the user navigates away — otherwise a big
// show (e.g. Detective Conan) keeps the backend busy long after nobody's waiting.
export function clientAbortSignal(request, reply) {
  const ac = new AbortController();
  const onClose = () => {
    // 'close' also fires on normal completion; only abort on a premature close.
    if (!reply.raw.writableEnded) ac.abort();
  };
  reply.raw.on('close', onClose);
  return ac.signal;
}
