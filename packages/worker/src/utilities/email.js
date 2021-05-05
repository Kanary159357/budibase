const nodemailer = require("nodemailer")
const CouchDB = require("../db")
const { StaticDatabases, determineScopedConfig } = require("@budibase/auth").db
const { EmailTemplatePurpose, TemplateTypes, Configs } = require("../constants")
const { getTemplateByPurpose } = require("../constants/templates")
const { getSettingsTemplateContext } = require("./templates")
const { processString } = require("@budibase/string-templates")
const { getResetPasswordCode, getInviteCode } = require("../utilities/redis")

const GLOBAL_DB = StaticDatabases.GLOBAL.name
const TYPE = TemplateTypes.EMAIL

const FULL_EMAIL_PURPOSES = [
  EmailTemplatePurpose.INVITATION,
  EmailTemplatePurpose.PASSWORD_RECOVERY,
  EmailTemplatePurpose.WELCOME,
]

function createSMTPTransport(config) {
  const options = {
    port: config.port,
    host: config.host,
    secure: config.secure || false,
    auth: config.auth,
  }
  if (config.selfSigned) {
    options.tls = {
      rejectUnauthorized: false,
    }
  }
  return nodemailer.createTransport(options)
}

async function getLinkCode(purpose, email, user) {
  switch (purpose) {
    case EmailTemplatePurpose.PASSWORD_RECOVERY:
      return getResetPasswordCode(user._id)
    case EmailTemplatePurpose.INVITATION:
      return getInviteCode(email)
    default:
      return null
  }
}

/**
 * Builds an email using handlebars and the templates found in the system (default or otherwise).
 * @param {string} purpose the purpose of the email being built, e.g. invitation, password reset.
 * @param {string} email the address which it is being sent to for contextual purposes.
 * @param {object|null} user If being sent to an existing user then the object can be provided for context.
 * @return {Promise<string>} returns the built email HTML if all provided parameters were valid.
 */
async function buildEmail(purpose, email, user) {
  // this isn't a full email
  if (FULL_EMAIL_PURPOSES.indexOf(purpose) === -1) {
    throw `Unable to build an email of type ${purpose}`
  }
  let [base, styles, body] = await Promise.all([
    getTemplateByPurpose(TYPE, EmailTemplatePurpose.BASE),
    getTemplateByPurpose(TYPE, EmailTemplatePurpose.STYLES),
    getTemplateByPurpose(TYPE, purpose),
  ])
  if (!base || !styles || !body) {
    throw "Unable to build email, missing base components"
  }
  base = base.contents
  styles = styles.contents
  body = body.contents

  // if there is a link code needed this will retrieve it
  const code = await getLinkCode(purpose, email, user)
  const context = {
    ...(await getSettingsTemplateContext(purpose, code)),
    email,
    user: user || {},
  }

  body = await processString(body, context)
  styles = await processString(styles, context)
  // this should now be the complete email HTML
  return processString(base, {
    ...context,
    styles,
    body,
  })
}

/**
 * Utility function for finding most valid SMTP configuration.
 * @param {object} db The CouchDB database which is to be looked up within.
 * @param {string|null} groupId If using finer grain control of configs a group can be used.
 * @return {Promise<object|null>} returns the SMTP configuration if it exists
 */
async function getSmtpConfiguration(db, groupId = null) {
  const params = {
    type: Configs.SMTP,
  }
  if (groupId) {
    params.group = groupId
  }
  return determineScopedConfig(db, params)
}

/**
 * Checks if a SMTP config exists based on passed in parameters.
 * @param groupId
 * @return {Promise<boolean>} returns true if there is a configuration that can be used.
 */
exports.isEmailConfigured = async (groupId = null) => {
  const db = new CouchDB(GLOBAL_DB)
  const config = await getSmtpConfiguration(db, groupId)
  return config != null
}

/**
 * Given an email address and an email purpose this will retrieve the SMTP configuration and
 * send an email using it.
 * @param {string} email The email address to send to.
 * @param {string} purpose The purpose of the email being sent (e.g. reset password).
 * @param {string|undefined} groupId If finer grain controls being used then this will lookup config for group.
 * @param {object|undefined} user if sending to an existing user the object can be provided, this is used in the context.
 * @return {Promise<object>} returns details about the attempt to send email, e.g. if it is successful; based on
 * nodemailer response.
 */
exports.sendEmail = async (email, purpose, { groupId, user } = {}) => {
  const db = new CouchDB(GLOBAL_DB)
  const config = await getSmtpConfiguration(db, groupId)
  if (!config) {
    throw "Unable to find SMTP configuration."
  }
  const transport = createSMTPTransport(config)
  const message = {
    from: config.from,
    subject: config.subject,
    to: email,
    html: await buildEmail(purpose, email, user),
  }
  return transport.sendMail(message)
}

/**
 * Given an SMTP configuration this runs it through nodemailer to see if it is infact functional.
 * @param {object} config an SMTP configuration - this is based on the nodemailer API.
 * @return {Promise<boolean>} returns true if the configuration is valid.
 */
exports.verifyConfig = async config => {
  const transport = createSMTPTransport(config)
  await transport.verify()
}
