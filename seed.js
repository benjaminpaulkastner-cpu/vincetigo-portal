const testData = {
  property: {
    address: '606 Union St, Apt 3B, Philadelphia, PA 19104',
    monthlyRent: 2150.00,
    securityDeposit: 2150.00,
  },
  tenant: {
    id: 'tenant_test_001',
    name: 'Ben Kastner (Test Account)',
    email: 'benjaminpaulkastner@gmail.com',
    stripeCustomerId: 'cus_test_sandbox_12345',
    leaseStatus: 'Active',
  },
  accounts: [
    {
      id: 'account_test_tenant_001',
      role: 'tenant',
      email: 'benjaminpaulkastner@gmail.com',
      environment: 'sandbox',
    },
  ],
};

module.exports = testData;