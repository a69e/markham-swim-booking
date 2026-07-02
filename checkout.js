const backButton = document.querySelector("#checkoutBack");
const message = document.querySelector("#checkoutMessage");

function tokenFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

function checkoutUrl(token) {
  return `./api/checkout?token=${encodeURIComponent(token)}`;
}

function openCheckout() {
  const token = tokenFromLocation();
  if (!token) {
    message.textContent = "Checkout link is missing.";
    return;
  }

  message.textContent = "Opening City of Markham checkout...";
  window.setTimeout(() => {
    window.location.href = checkoutUrl(token);
  }, 250);
}

backButton.addEventListener("click", () => {
  window.location.href = "./";
});

openCheckout();
