// Existing fixtures and assertions use German labels. Language tests explicitly
// clear or replace this preference to exercise the English application default.
localStorage.setItem("basalt-settings", JSON.stringify({ language: "de" }));
