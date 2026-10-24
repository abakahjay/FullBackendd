// Marketing email (welcome mails, app updates, notifications) must show a valid
// postal address under CAN-SPAM; a PO box or virtual mailbox is fine. Set
// MAIL_POSTAL_ADDRESS (one line, e.g. "P.O. Box 123, Accra, Ghana") on the host
// and every app mailer prints it in its footer. Unset: nothing is added.
const postalAddress = () => (process.env.MAIL_POSTAL_ADDRESS || "").trim();

module.exports = { postalAddress };
