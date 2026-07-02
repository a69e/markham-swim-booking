const backButton = document.querySelector("#checkoutBack");
const openButton = document.querySelector("#checkoutOpen");
const message = document.querySelector("#checkoutMessage");
const frame = document.querySelector("#checkoutFrame");

function homeUrl() {
  return "./";
}

function tokenFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token") || "";
}

async function loadCheckout() {
  const token = tokenFromLocation();
  if (!token) {
    message.textContent = "Checkout link is missing.";
    return;
  }

  try {
    const response = await fetch(`./api/checkout?token=${encodeURIComponent(token)}&format=json`, {
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.checkoutUrl) {
      throw new Error(data.error || "Checkout link expired.");
    }

    openButton.hidden = false;
    openButton.addEventListener("click", () => {
      window.location.href = data.checkoutUrl;
    });
    frame.src = data.checkoutUrl;
    message.hidden = true;
  } catch (error) {
    message.textContent = error.message || "Checkout could not be opened.";
  }
}

backButton.addEventListener("click", () => {
  window.location.href = homeUrl();
});

loadCheckout();
