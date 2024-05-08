require('dotenv').config();
const express = require('express');
const request = require('request-promise-native');
const NodeCache = require('node-cache');
const session = require('express-session');
const opn = require('open');
const app = express();

const PORT = 3000;

const refreshTokenStore = {};

const accessTokenCache = new NodeCache({ deleteOnExpire: true });

if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
  throw new Error('Missing CLIENT_ID or CLIENT_SECRET environment variable.');
}

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  All the following values must match configuration settings in your app.
//  They will be used to build the OAuth URL, which users visit to begin
//  installing. If they don't match your app's configuration, users will
//  see an error page.

// Replace the following with the values from your app auth config,
// or set them as environment variables before running.
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Scopes for this app will default to `crm.objects.contacts.read`
// To request others, set the SCOPE environment variable instead
let SCOPES = [
  'tickets',
  'e-commerce',
  'content',
  'oauth',
  'crm.objects.companies.read',
  'conversations.read',
  'crm.objects.deals.read',
  'crm.objects.contacts.read',
];
if (process.env.SCOPE) {
  SCOPES = process.env.SCOPE.split(/ |, ?|%20/).join(' ');
}

// On successful install, users will be redirected to /oauth-callback
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`;

//===========================================================================//

// Use a session to keep track of client ID
app.use(
  session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true,
  })
);

//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user
// to when they choose to install the app
const authUrl =
  'https://app.hubspot.com/oauth/authorize' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
  `&scope=${encodeURIComponent(SCOPES.join(' '))}` + // scopes being requested by the app
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page

// Redirect the user from the installation page to
// the authorization URL
app.get('/install', (req, res) => {
  console.log(authUrl);
  console.log('');
  console.log('=== Initiating OAuth 2.0 flow with HubSpot ===');
  console.log('');
  console.log("===> Step 1: Redirecting user to your app's OAuth URL");
  res.redirect(authUrl);
  console.log('===> Step 2: User is being prompted for consent by HubSpot');
});

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed
app.get('/oauth-callback', async (req, res) => {
  console.log('===> Step 3: Handling the request sent by the server');

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log('       > Received an authorization token');

    const authCodeProof = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code,
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log(
      '===> Step 4: Exchanging authorization code for an access token and refresh token'
    );
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      return res.redirect(`/error?msg=${token.message}`);
    }

    // Once the tokens have been retrieved, use them to make a query
    // to the HubSpot API
    res.redirect(`/`);
  }
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

const exchangeForTokens = async (userId, exchangeProof) => {
  try {
    const responseBody = await request.post(
      'https://api.hubapi.com/oauth/v1/token',
      {
        form: exchangeProof,
      }
    );
    // Usually, this token data should be persisted in a database and associated with
    // a user identity.
    const tokens = JSON.parse(responseBody);
    refreshTokenStore[userId] = tokens.refresh_token;
    accessTokenCache.set(
      userId,
      tokens.access_token,
      Math.round(tokens.expires_in * 0.75)
    );

    console.log('       > Received an access token and refresh token');
    return tokens.access_token;
  } catch (e) {
    console.error(
      `       > Error exchanging ${exchangeProof.grant_type} for access token`
    );
    return JSON.parse(e.response.body);
  }
};

const refreshAccessToken = async (userId) => {
  const refreshTokenProof = {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshTokenStore[userId],
  };
  return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log('Refreshing expired access token');
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId);
};

const isAuthorized = (userId) => {
  return refreshTokenStore[userId] ? true : false;
};

//====================================================//
//   Using an Access Token to Query the HubSpot API   //
//====================================================//

const getContact = async (accessToken) => {
  console.log('');
  console.log(
    '=== Retrieving a contact from HubSpot using the access token ==='
  );
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    console.log(
      '===> Replace the following request.get() to test other API calls'
    );
    console.log(
      "===> request.get('https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1')"
    );
    const result = await request.get(
      'https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1',
      {
        headers: headers,
      }
    );

    return JSON.parse(result).contacts[0];
  } catch (e) {
    console.error('  > Unable to retrieve contact');
    return JSON.parse(e.response.body);
  }
};

//========================================//
//   Displaying information to the user   //
//========================================//

const displayContactName = (res, contact) => {
  if (contact.status === 'error') {
    res.write(
      `<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`
    );
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(`<p>Contact name: ${firstname.value} ${lastname.value}</p>`);
};

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  console.log('authUrl: ', authUrl);
  res.write(`<h1>HubSpot OAuth 2.0 Quickstart App</h1>`);
  if (isAuthorized(req.sessionID)) {
    const accessToken = await getAccessToken(req.sessionID);
    const contact = await getContact(accessToken);
    res.write(`<h2>Congratulations, you've installed the app</h2>`);
    let pageCreation = await createPage(accessToken);

    res.write(
      `<h4>Page created:<a href="${pageCreation.url}">${pageCreation.url}</a></h4>`
    );
    displayContactName(res, contact);
  } else {
    res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  }
  res.end();
});

app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

app.listen(PORT, () =>
  console.log(`=== Starting your app on http://localhost:${PORT} ===`)
);
opn(`http://localhost:${PORT}`);

const createPage = async (accessToken) => {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const pageData = {
    domain: '',
    htmlTitle: 'New Page',
    name: 'New Page',
    state: 'PUBLISHED',
    templatePath: '@hubspot/growth/templates/paid-consultation.html',
    useFeaturedImage: false,
    layoutSections: {
      dnd_area: {
        cells: [],
        cssClass: '',
        cssId: '',
        cssStyle: '',
        label: 'Main section',
        name: 'dnd_area',
        params: {},
        rowMetaData: [
          {
            cssClass: 'dnd-section',
            styles: {
              backgroundColor: {
                a: 1,
                b: 250,
                g: 248,
                r: 245,
              },
              forceFullWidthSection: false,
            },
          },
          {
            cssClass: 'dnd-section',
            styles: {
              backgroundColor: {
                a: 1,
                b: 255,
                g: 255,
                r: 255,
              },
              forceFullWidthSection: false,
            },
          },
        ],
        rows: [
          {
            0: {
              cells: [],
              cssClass: '',
              cssId: '',
              cssStyle: '',
              name: 'dnd_area-column-2',
              params: {
                css_class: 'dnd-column',
              },
              rowMetaData: [
                {
                  cssClass: 'dnd-row',
                },
                {
                  cssClass: 'dnd-row',
                },
                {
                  cssClass: 'dnd-row',
                },
              ],
              rows: [
                {
                  0: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-3',
                    params: {
                      child_css: {},
                      css: {},
                      css_class: 'dnd-module',
                      extra_classes: 'widget-type-rich_text',
                      html: "<div style='text-align:center;'>\n<h2><strong>About</strong></h2>\n</div>",
                      path: '@hubspot/rich_text',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 12,
                    x: 0,
                  },
                },
                {
                  0: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-column-4',
                    params: {
                      css_class: 'dnd-column',
                    },
                    rowMetaData: [
                      {
                        cssClass: 'dnd-row',
                        styles: {},
                      },
                    ],
                    rows: [
                      {
                        0: {
                          cells: [],
                          cssClass: '',
                          cssId: '',
                          cssStyle: '',
                          name: 'dnd_area-module-5',
                          params: {
                            child_css: {},
                            css: {},
                            css_class: 'dnd-module',
                            extra_classes: 'widget-type-linked_image',
                            horizontal_alignment: 'CENTER',
                            img: {
                              alt: 'Growth theme placeholder image',
                              loading: 'lazy',
                              max_height: 500,
                              max_width: 500,
                              size_type: 'auto_custom_max',
                              src: '//7528309.fs1.hubspotusercontent-na1.net/hubfs/7528309/raw_assets/public/mV0_d-cms-growth-theme_hubspot/growth/images/service-one.jpg',
                            },
                            path: '@hubspot/linked_image',
                            schema_version: 2,
                            smart_objects: [],
                            smart_type: 'NOT_SMART',
                            style: 'margin-bottom: 22px;',
                            wrap_field_tag: 'div',
                          },
                          rowMetaData: [],
                          rows: [],
                          styles: {
                            flexboxPositioning: 'TOP_CENTER',
                          },
                          type: 'custom_widget',
                          w: 12,
                          x: 0,
                        },
                      },
                    ],
                    type: 'cell',
                    w: 6,
                    x: 0,
                  },
                  6: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-column-6',
                    params: {
                      css_class: 'dnd-column',
                    },
                    rowMetaData: [
                      {
                        cssClass: 'dnd-row',
                      },
                    ],
                    rows: [
                      {
                        0: {
                          cells: [],
                          cssClass: '',
                          cssId: '',
                          cssStyle: '',
                          name: 'dnd_area-module-7',
                          params: {
                            child_css: {},
                            css: {},
                            css_class: 'dnd-module',
                            extra_classes: 'widget-type-rich_text',
                            html: '<p>Add a short description about the work that you do at your company. Try to narrow in on your specialization so that you can capture the attention of your clients. Talk about the value that you can deliver through a paid consultation.</p>',
                            path: '@hubspot/rich_text',
                            schema_version: 2,
                            smart_objects: [],
                            smart_type: 'NOT_SMART',
                            wrap_field_tag: 'div',
                          },
                          rowMetaData: [],
                          rows: [],
                          type: 'custom_widget',
                          w: 12,
                          x: 0,
                        },
                      },
                    ],
                    type: 'cell',
                    w: 6,
                    x: 6,
                  },
                },
                {
                  0: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-8',
                    params: {
                      button_link: {
                        no_follow: false,
                        open_in_new_tab: false,
                        rel: '',
                        sponsored: false,
                        url: {
                          href: '#book',
                        },
                        user_generated_content: false,
                      },
                      button_text: 'Book a consultation',
                      child_css: {},
                      css: {},
                      css_class: 'dnd-module',
                      path: '../modules/button',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      styles: {
                        alignment: {
                          alignment: {
                            css: '',
                            horizontal_align: 'CENTER',
                          },
                        },
                      },
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 12,
                    x: 0,
                  },
                },
              ],
              styles: {},
              type: 'cell',
              w: 12,
              x: 0,
            },
          },
          {
            0: {
              cells: [],
              cssClass: '',
              cssId: '',
              cssStyle: '',
              name: 'dnd_area-column-9',
              params: {
                css_class: 'dnd-column',
              },
              rowMetaData: [
                {
                  cssClass: 'dnd-row',
                  styles: {},
                },
                {
                  cssClass: 'dnd-row',
                },
                {
                  cssClass: 'dnd-row',
                },
              ],
              rows: [
                {
                  0: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-10',
                    params: {
                      child_css: {},
                      css: {},
                      css_class: 'dnd-module',
                      extra_classes: 'widget-type-rich_text',
                      html: '<a id="services" data-hs-anchor="true"></a>\n<div style="text-align: center;">\n<h2>A suite of tools at your disposal</h2>\n<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n</div>',
                      path: '@hubspot/rich_text',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 12,
                    x: 0,
                  },
                },
                {
                  0: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-11',
                    params: {
                      child_css: {},
                      content: {
                        content:
                          "<h3 style='text-align:center;'>Service</h3><p>Summarize the service you provide. Add a message about the value that you can provide to your customers.</p>",
                      },
                      css: {},
                      css_class: 'dnd-module',
                      icon: {
                        icon: {
                          icon_set: 'fontawesome-5.0.10',
                          name: 'balance-scale',
                          type: 'SOLID',
                          unicode: 'f24e',
                        },
                      },
                      path: '../modules/service-card',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      styles: {
                        card: {
                          spacing: {
                            spacing: {
                              css: 'margin-bottom: 22px;\n',
                              margin: {
                                bottom: {
                                  units: 'px',
                                  value: 22,
                                },
                              },
                            },
                          },
                        },
                        icon: {
                          background: {
                            color: {
                              color: '#494a52',
                              css: '#494a52',
                              hex: '#494a52',
                              opacity: 100,
                              rgb: 'rgb(73, 74, 82)',
                              rgba: 'rgba(73, 74, 82, 1)',
                            },
                          },
                        },
                      },
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 4,
                    x: 0,
                  },
                  4: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-12',
                    params: {
                      child_css: {},
                      content: {
                        content:
                          "<h3 style='text-align:center;'>Service</h3><p>Summarize the service you provide. Add a message about the value that you can provide to your customers.</p>",
                      },
                      css: {},
                      css_class: 'dnd-module',
                      icon: {
                        icon: {
                          icon_set: 'fontawesome-5.0.10',
                          name: 'industry',
                          type: 'SOLID',
                          unicode: 'f275',
                        },
                      },
                      path: '../modules/service-card',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      styles: {
                        card: {
                          spacing: {
                            spacing: {
                              css: 'margin-bottom: 22px;\n',
                              margin: {
                                bottom: {
                                  units: 'px',
                                  value: 22,
                                },
                              },
                            },
                          },
                        },
                        icon: {
                          background: {
                            color: {
                              color: '#494a52',
                              css: '#494a52',
                              hex: '#494a52',
                              opacity: 100,
                              rgb: 'rgb(73, 74, 82)',
                              rgba: 'rgba(73, 74, 82, 1)',
                            },
                          },
                        },
                      },
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 4,
                    x: 4,
                  },
                  8: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-13',
                    params: {
                      child_css: {},
                      content: {
                        content:
                          "<h3 style='text-align:center;'>Service</h3><p>Summarize the service you provide. Add a message about the value that you can provide to your customers.</p>",
                      },
                      css: {},
                      css_class: 'dnd-module',
                      icon: {
                        icon: {
                          icon_set: 'fontawesome-5.0.10',
                          name: 'server',
                          type: 'SOLID',
                          unicode: 'f233',
                        },
                      },
                      path: '../modules/service-card',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      styles: {
                        card: {
                          spacing: {
                            spacing: {
                              css: 'margin-bottom: 22px;\n',
                              margin: {
                                bottom: {
                                  units: 'px',
                                  value: 22,
                                },
                              },
                            },
                          },
                        },
                        icon: {
                          background: {
                            color: {
                              color: '#494a52',
                              css: '#494a52',
                              hex: '#494a52',
                              opacity: 100,
                              rgb: 'rgb(73, 74, 82)',
                              rgba: 'rgba(73, 74, 82, 1)',
                            },
                          },
                        },
                      },
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 4,
                    x: 8,
                  },
                },
                {
                  0: {
                    cells: [],
                    cssClass: '',
                    cssId: '',
                    cssStyle: '',
                    name: 'dnd_area-module-14',
                    params: {
                      button_link: {
                        no_follow: false,
                        open_in_new_tab: false,
                        rel: '',
                        sponsored: false,
                        url: {
                          href: '#book',
                        },
                        user_generated_content: false,
                      },
                      button_text: 'Book a consultation',
                      child_css: {},
                      css: {},
                      css_class: 'dnd-module',
                      path: '../modules/button',
                      schema_version: 2,
                      smart_objects: [],
                      smart_type: 'NOT_SMART',
                      styles: {
                        alignment: {
                          alignment: {
                            css: '',
                            horizontal_align: 'CENTER',
                          },
                        },
                      },
                      wrap_field_tag: 'div',
                    },
                    rowMetaData: [],
                    rows: [],
                    type: 'custom_widget',
                    w: 12,
                    x: 0,
                  },
                },
              ],
              type: 'cell',
              w: 12,
              x: 0,
            },
          },
        ],
        type: 'cell',
        w: 12,
        x: 0,
      },
    },
  };

  try {
    const result = await request.post(
      'https://api.hubapi.com/cms/v3/pages/site-pages',
      {
        headers: headers,
        body: JSON.stringify(pageData),
      }
    );
    return JSON.parse(result);
  } catch (e) {
    console.error('Unable to create page');
    const errorResponse = JSON.parse(e.response.body);
    if (errorResponse.errors && errorResponse.errors.length > 0) {
      console.log('Error context:', errorResponse.errors[0].context);
    }
    return JSON.parse(e.response.body);
  }
};
