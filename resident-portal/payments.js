const STRIPE_URL = 'https://buy.stripe.com/9B600i1KMe4d0rw2t44F200';
const STRIPE_PAYMENT_LINKS = Object.freeze({
  'unit-3b': { deposit: STRIPE_URL },
  'apartment-2': {
    rent: 'https://buy.stripe.com/fZufZg7568JT3DI9Vw4F202',
    deposit: STRIPE_URL,
  },
  'apartment-3': {
    rent: 'https://buy.stripe.com/8x23cudtuf8h1vAaZA4F201',
  },
});

function openResidentPayment(button) {
  const unitId = button.dataset.paymentUnit || '';
  const purpose = button.dataset.paymentPurpose || 'rent';

  if (purpose === 'deposit') {
    window.open(STRIPE_URL, '_blank', 'noopener,noreferrer');
    return;
  }

  const paymentUrl = STRIPE_PAYMENT_LINKS[unitId]?.[purpose];
  if (!paymentUrl) {
    window.alert('Online payment is not configured for this unit.');
    return;
  }

  window.open(paymentUrl, '_blank', 'noopener,noreferrer');
}
