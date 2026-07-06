const backButton = document.querySelector("#checkoutBack");
const message = document.querySelector("#checkoutMessage");

function tokenFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

function checkoutUrl(token) {
  return `./api/checkout?token=${encodeURIComponent(token)}`;
}

function openedKey(token) {
  return `markhamCheckoutOpened:${token}`;
}

function openCheckout() {
  const token = tokenFromLocation();
  if (!token) {
    message.textContent = "Checkout link is missing.";
    return;
  }

  if (sessionStorage.getItem(openedKey(token)) === "true") {
    message.textContent = "Checking registration status...";
    window.setTimeout(() => {
      window.location.href = "./?checkoutReturn=1";
    }, 700);
    return;
  }

  sessionStorage.setItem(openedKey(token), "true");
  message.textContent = "Opening City of Markham checkout...";
  window.setTimeout(() => {
    window.location.href = checkoutUrl(token);
  }, 250);
}

backButton.addEventListener("click", () => {
  window.location.href = "./";
});

openCheckout();
