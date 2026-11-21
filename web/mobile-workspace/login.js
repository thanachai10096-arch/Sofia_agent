(() => {
  "use strict";
  if (new URLSearchParams(location.search).get("auth") === "failed") {
    const error = document.getElementById("error");
    if (error) error.style.display = "block";
  }
})();
