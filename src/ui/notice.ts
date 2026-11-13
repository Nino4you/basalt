import { h } from "./dom";

function container(): HTMLElement {
  // Shared with plugin notices, which look this element up on document.body.
  let element = document.body.querySelector<HTMLElement>(".notice-container");
  if (!element) {
    element = h("div", "notice-container");
    document.body.append(element);
  }
  return element;
}

export function notify(message: string, error = false): void {
  const notice = h("div", {
    class: `notice${error ? " mod-error" : ""}`,
    text: message,
    attrs: { role: error ? "alert" : "status" },
  });
  const remove = () => {
    notice.classList.add("is-leaving");
    setTimeout(() => notice.remove(), 160);
  };
  notice.addEventListener("click", remove);
  container().append(notice);
  setTimeout(remove, error ? 10000 : 4500);
}
