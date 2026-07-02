const backButton = document.querySelector("#checkoutBack");
const openButton = document.querySelector("#checkoutOpen");
const inlineOpenButton = document.querySelector("#checkoutOpenInline");
const message = document.querySelector("#checkoutMessage");
const frame = document.querySelector("#checkoutFrame");
let officialCheckoutUrl = "";

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

    officialCheckoutUrl = data.checkoutUrl;
    openButton.hidden = false;
    inlineOpenButton.hidden = false;
    frame.src = data.checkoutUrl;
    message.textContent = "Opening official checkout...";
    window.setTimeout(() => {
      message.textContent = "If checkout stays blank, open the official checkout.";
    }, 2200);
  } catch (error) {
    message.textContent = error.message || "Checkout could not be opened.";
  }
}

function openOfficialCheckout() {
  if (officialCheckoutUrl) window.location.href = officialCheckoutUrl;
}

openButton.addEventListener("click", openOfficialCheckout);
inlineOpenButton.addEventListener("click", openOfficialCheckout);

frame.addEventListener("load", () => {
  if (frame.src) message.hidden = true;
});

backButton.addEventListener("click", () => {
  window.location.href = homeUrl();
});

loadCheckout();
