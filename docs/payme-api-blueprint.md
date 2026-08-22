FORMAT: 1A

# PayMe Marketplace API

<!--![PayMe](https://live.payme.io/images/logos/payme-main-logo.png)-->

Our API is designed to allow platforms to offer a full payment solution as part of their product.

Using the API you can:
<ul>
<li>Create and manage sellers on your platform</li>
<li>Allow sellers to accept credit card payments</li>
<li>Create standard transactions</li>
<li>Create recurring payments</li>
<li>Use our secured payment pages</li>
<li>Use Tokenization for delayed & future payments</li>
<li>Charge a platform fee from every transaction</li>
<li>Query data regarding sellers, transactions, subscriptions, withdrawals and more</li>
</ul>
PCI compliant and want to use the direct credit card API? 

[Let us know!](http://www.payme.io)

## API Capabilities and Structure
By using the API you will be able to handle all transactions on your website without dealing with sensitive credit card details, processing difficulties or PCI compliancy. 


**The basics are simple.** You **POST** required information to our target URL's using **JSON** format and get replies structured in **JSON** format. You are free to use whatever programming language you prefer.

**Note:** Do not forget to add the header `Content-Type: application/json` to your requests!

**Callbacks** - We have an option to send out a server to server notifications, also known as "IPN". For example: a customer successfully paying using the IFRAME; a successful subscription iteration. The format and details are described throughout this document. 
The callback is a **POST** request of type `x-www-form-urlencoded` to your provided target URL.

## Getting Started and Connection Details
Please review the API document. Below each API call description are listed the relevant target URL's for the **staging** and **production** enviroments and a link to view an example of the API call and potential responses on the right panel.
<br /><br />

You will receive the following credentials from your account manager.
**Do not share your key or secret!**

| Attribute             | Description   |
|:----------------------|:--------------|
| payme_client_key      | Your private key provided by us for authentication of marketplace |
| payme_merchant_secret | Your secret key provided by PayMe for authentication of marketplace |

Not a client yet? [Apply now](http://www.payme.io)

## Service URLs
In order to work with the API, you should use the service URLs according to the required environments, **Staging** or **Production**.

When interacting with the API, make sure you point to the correct environment, with the correct credentials. Both URLs will be stated next to each function.

| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/` |
| Production    | `https://live.payme.io/api/` |

## Credit Card Numbers for Testing Purposes
Please use the following credit card when integrating only in the **Staging** environment.

**Main credit card numbers for testing**

| Credit Card | Details   |
|:------------|:----------|
| Card Number: `4580458045804580`<br/>Expiration: `Any future date`<br/>CVV: `Any 3 digits` | Acts as an _international non-Israeli_ card.<br/>Accepts sales with only *one* installment.<br/>Accepts sales in `ILS`, `USD`, `EUR`. |
| Card Number: `4580000000000000`<br/>Expiration: `Any future date`<br/>CVV: `Any 3 digits` | Acts as an _international Israeli_ card.<br/>Accepts sales with *multiple* installments.<br/>Accepts sales in `ILS`, `USD`, `EUR`. |
| Card Number: `12312312`<br/>Expiration: `Any future date`<br/>CVV: `Any 3 digits`         | Acts as a _local Israeli_ card.<br/>Accepts sales with *multiple* installments.<br/>Accepts sales in `ILS` only. |

**Secondary credit card numbers for testing**

| Credit Card Type  | Credit Card Number    |
|:------------------|:----------------------|
| Visa              | 4111111111111111<br/>4200000000000000 |
| Mastercard        | 5555555555554444<br/>5454545454545454 |
| AmericanExpress   | 378282246310005<br/>377777777777770   |
| Diners            | 38520000023237        |
| Discover          | 6011000990139424      |
| JCB               | 3530111333300000      |
| Isracard          | 12312312              |

**Credit card numbers for testing specific responses and errors**

| Card Number      | Description    |
|:-----------------|:---------------|
| 4000000000000002 | Payment is declined with a card declined error          |
| 4000000000000051 | Payment is declined with a card blocked error           |
| 4000000000000085 | Payment is declined with a card stolen error            |
| 4000000000000069 | Payment is declined with a card expired error           |
| 4000000000000101 | Payment is declined with a required CVV error           |
| 4000000000000127 | Payment is declined with an incorrect CVV               |
| 4000000000000135 | Payment is declined with a credit limit reached error   |
| 4242424242424241 | Payment is declined with an incorrect card number error |

## Merchant Default URLs
<a name="merchant-default-urls"></a>
Upon creating your Merchant account with us, you will be required to provide a few default URLs for various calls.
More examples can be found further in the documentation.

| Environment   | URL           |
|:--------------|:--------------|
| Callback URL  | Used for server-to-server responses regarding calls made to our API.<br>These will be **x-www-form-urlencoded** formatted **POST** requests to the URL. |
| Return URL    | **IFRAME users only** - We will redirect the customer to this URL after the sale is paid successfully. **This is usually the success page.**<br>Those will be **GET** requests with parameters. |

[//]: # (| Error URL     | **IFRAME users only** - We will return the error details of your call to this URL.<br>Those will be **GET** requests with parameters. |)
[//]: # (| Cancel URL    | **IFRAME users only** - We will return the response to this address in case user cancels transaction. **Not in use at the moment.** |)

# Group Sellers
We allow platforms and marketplaces to manage sellers. 

In order to accomplish this goal, we require the marketplace to collect certain details during a seller's registration. 
Once the seller is registered, the marketplace is required to convey the required information to us through a dedicated API. 
Upon completion, the API will return the new seller information within the our system. 

![CreateSeller](http://i.imgur.com/lU2TKH8.png?1)

## Create Seller [/create-seller]

#### **Target URLs**

| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/create-seller` |
| Production    | `https://live.payme.io/api/create-seller` |

#### **Notes**

**Note 1:** You can find the full list of business category codes / MCC [here](https://docs.google.com/document/d/1RGZoMNGlL6MLQ9uvVZDqSBsbM49Y8ZxA-69L_P4lCyA).

<a name="testing-values-list"></a>
**Note 2:** For testing purposes you can use the following testing values:

|    Attributes                 |   Value               |
|:------------------------------|:----------------------|
| `seller_social_id`            | `9999999999`          |
| `seller_email`                | `random@paymeservice.com` Note that by using this email you will not receive any automatic emails sent from the system |
| `seller_bank_code`            | `54`                  |
| `seller_bank_branch`          | `123` Any 3 digits    |
| `seller_bank_account_number`  | `123456` Any 6 digits |

<a name="bank-codes-list"></a>
**Note 3:** Below is the list of all valid codes accepted in the `seller_bank_code` attribute:

| Code |   Name            |
|:-----|:------------------|
| `4`  | בנק יהב לעובדי המדינה |
| `9`  | בנק הדואר |
| `10` | בנק לאומי |
| `11` | בנק דיסקונט |
| `12` | בנק הפועלים |
| `13` | בנק אגוד לישראל |
| `14` | בנק אוצר החייל |
| `17` | בנק מרכנתיל דסקונט |
| `20` | בנק מזרחי-טפחות |
| `22` | סיטיבנק |
| `23` | HSBC |
| `26` | UBANK |
| `31` | הבין לאומי הראשון |
| `34` | בנק ערבי ישראלי |
| `39` | בנק אוף אינדיה |
| `46` | בנק מסד |
| `52` | בנק פאגי |
| `54` | בנק ירושלים |
| `68` | דקסיה ישראל |
| `77` | בנק לאומי למשכנתאות |
| `90` | בנק דיסקונט למשכנתאות |
| `91` | משכן בנהפ למשכנתאות |
| `92` | הבין לאומי למשכנתאות |

<a name="country-codes-list"></a>
**Note 4:** You can find the full list of ISO 3166 country codes [here](https://en.wikipedia.org/wiki/List_of_ISO_3166_country_codes).


+ Attributes (Create Seller Request)

### Create Seller [POST]

#### <a name="seller-callback"></a> Callback upon Seller creation or update

Once the Seller is created or updated, we will notify the marketplace with the Seller details with a **POST** request of type `x-www-form-urlencoded` to the marketplace [**Default Callback URL**](#merchant-default-urls).

| Attribute             | Description |
|:----------------------|:------------|
| status_code           | `0` Status of the request (0 - success, 1 - error) |
| status_error_code     | In case of an error, our unique error code |
| status_error_details  | In case of an error, the error message |
| notify_type           | `seller-create` [Seller notification types](#seller-notification-types) |
| seller_payme_id       | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique seller ID |
| seller_id             | `12345` Merchant's unique seller ID for correlation with us |
| seller_created        | `2016-01-01 15:15:15` |
| seller_first_name     | `First` First name of the account owner |
| seller_last_name      | `Last` Last name of the account owner |
| seller_social_id      | `999999999` Social ID of the account owner |
| seller_birthdate      | `1989-05-06` Seller’s birth date. yyyy-mm-dd formatted |
| seller_gender         | `0` Seller’s gender (0 - Male, 1 - Female) |
| seller_email          | `personal@example.com` Seller's personal email |
| seller_contact_email  | `contact@example.com` Seller's contact email that will be displayed to the buyers |
| seller_phone          | `0540123456` Seller's personal phone |
| seller_contact_phone  | `031234567` Seller's contact phone that will be displayed to the buyers |
| seller_inc            | `2` Seller's incorporation type (0/1 - Private Individual/Sole Proprietorship, 2 - Licensed Company, 3 - Corporation, 4 - Registered Partnership, 5 - Exempt Company, 6 - Non Profit, 7 - LLC Limited Liability Company) |
| seller_inc_code       | `123456` Seller's business ID (ח.פ, ע.מ) |
| seller_merchant_name  | `Baby Ducks` Seller's merchant name |
| seller_site_url       | `www.babyducks.com` Seller’s site URL |
| seller_address_city          | `Tel Aviv` Seller's business address - city |
| seller_address_street        | `Rothschild` Seller's business address - street |
| seller_address_street_number | `45` Seller's business address - street number |
| seller_address_country       | `IL` Seller's business address - country (ISO 3166-1 alpha-2 format) |
| seller_active         | `1` Seller's active state (0 - inactive, 1 - active) |
| seller_approved       | `1` Seller's approval state (0 - not approved, 1 - approved) |
| seller_currencies     | `[ILS, USD, EUR]` Array of allowed currencies |

#### <a name="seller-notification-types"></a> Seller Callback Notification Types
| Notification      | Description   |
|:------------------|:--------------|
| `seller-create`   | The seller was created |
| `seller-update`   | The seller details were updated |

+ Attributes (Create Seller Request)

+ Request (application/json)

        {
            "payme_client_key": "XXXXXXXX",
            "seller_id": "12345",
            "seller_first_name": "First",
            "seller_last_name": "Last",
            "seller_social_id": "9999999999",
            "seller_birthdate": "06/05/1989",
            "seller_social_id_issued": "01/01/2000",
            "seller_gender": 0,
            "seller_email": "personal@example.com",
            "seller_phone": "0540123456",
            "seller_contact_email": "contact@example.com",
            "seller_contact_phone": "031234567",
            "seller_bank_code": 54,
            "seller_bank_branch": 123,
            "seller_bank_account_number": "123456",
            "seller_description": "An online store which specializes in rubber ducks",
            "seller_site_url": "www.babyducks.com",
            "seller_person_business_type": 2000,
            "seller_inc": 2,
            "seller_inc_code": "123456",
            "seller_retail_type": 1,
            "seller_merchant_name": "Baby Ducks",
            "seller_address_city": "Tel Aviv",
            "seller_address_street": "Rothschild",
            "seller_address_street_number": "1",
            "seller_address_country": "IL",
            "market_fee": 5.0
        }

+ Response 200 (application/json)
    + Attributes (object)
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique private seller ID
        + seller_payme_secret: `ABCDEFGHIJKLMOPQRSTUVWXYZ` (string) - Our unique seller secret key
        + seller_public_key: `e6dccf12-03e7-4fc4-906e-625487c9c259` (string) - Our unique seller public key
        + seller_id: `12345` (string) - Merchant's unique seller ID for correlation with us
        + seller_dashboard_signup_link: `~URL~` (string) - Our unique onboarding URL. Please contact our Support for additional information

    + Body
    
            {
              "status_code": 0,
              "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
              "seller_payme_secret": "ABCDEFGHIJKLMOPQRSTUVWXYZ",
              "seller_public_key": {
                "uuid": "e6dccf12-03e7-4fc4-906e-625487c9c259",
                "description": "PayMe-Public-Key",
                "is_active": true
              },
              "seller_id": "12345",
              "seller_dashboard_signup_link": "https://www.PayMe-Onboarding-URL.com"
            }
            
+ Response 500 (application/json)
    + Attributes (object)
        + status_code: `1` (number) - Status of the request (0 - success, 1 - error)
        + status_error_details: `דואר אלקטרוני כבר בשימוש` (string) - Error message
        + status_additional_info (string) - Additional error information
        + status_error_code: `150` (number) - Our unique error code 

    + Body
    
            {
              "status_code": 1,
              "status_error_details": "דואר אלקטרוני כבר בשימוש",
              "status_additional_info": null,
              "status_error_code": 150
            }

## Upload Seller Files [/upload-seller-files]

Upload the required files **after** Seller creation.

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/upload-seller-files` |
| Production    | `https://live.payme.io/api/upload-seller-files` |

+ Attributes (Upload Seller Files Request)

### Upload Seller Files [POST]

You can choose to upload the files using one or both of the following formats:

#### URL of the file

| Attribute | Description |
|:----------|:------------|
| name      | `social_id.pdf` File name with extension |
| type      | `1` The document type [code](#doc-type-codes) |
| url       | `https://www.mysite.com/files/social_id.pdf` The URL of the file |
| mime_type | `application/pdf` The mime type of the file |


#### base64 encoded file

| Attribute | Description |
|:----------|:------------|
| name      | `social_id.pdf` File name with extension |
| type      | `1` The document type [code](#doc-type-codes) |
| base64    | The base64 encoded file |
| mime_type | `application/pdf` The mime type of the file |

#### <a name="doc-type-codes"></a> Document type codes 
| Name                             | Code | Description |
|:---------------------------------|:----:|:------------|
| Social Id                        | 1    | Social ID document (תעודת הזהות). For additional information see Note 3 above |
| Bank Account Ownership           | 2    | Proof of bank account ownership or a cancelled cheque photo (שיק מבוטל או אישור ניהול חשבון בנק). For additional information see Note 3 above |
| Corporate Certificate            | 3    | Incorporation document (תעודת התאגדות של עוסק פטור/עוסק מורשה/חברה בע"מ/עמותה). For additional information see Note 3 above |
| Bank Authorization               | 4    | Bank authorization (הרשאה לחיוב חשבון) |
| Personal Guarantee               | 5    | Personal guarantee (ערבות אוואל). Relevant only if was requested by your Account Manager |
| Promissory Note                  | 6    | Promissory note (שטר חוב). Relevant only if was requested by your Account Manager |
| Processing Agreement             | 7    | Processing agreement (הסכם סליקה). Relevant only if was requested by your Account Manager |
| Signature                        | 8    | Signature (חתימה). Relevant only if was requested by your Account Manager |
| Stamp                            | 9    | Stamp (חותמת). Relevant only if was requested by your Account Manager |
| Signatories Approval             | 10   | Signatories approval (מורשה חתימה). Relevant only if was requested by your Account Manager |
| Additional License               | 11   | Additional license (רשיון נוסף). Relevant only if was requested by your Account Manager |
| Public Representative            | 12   | Public representative document (הצהרת איש ציבור). Relevant only if was requested by your Account Manager |
| Regulatory Authentication        | 13   | Regulatory authentication (נסח חברה או BDI). Relevant only if was requested by your Account Manager |
| Authorized Signer Protocol       | 14   | Authorized signer protocol (פרוטוקול מורשי חתימה). Relevant only if was requested by your Account Manager |
| Business Proof                   | 15   | Business proof document (אישור עסק). Relevant only if was requested by your Account Manager |
| Service Receiver                 | 16   | Service receiver document (הצהרת מקבל שירות). Relevant only if was requested by your Account Manager |
| Face-To-Face Approval            | 17   | Face-To-Face approval (אישור זיהוי פנים מול פנים). Relevant only if was requested by your Account Manager |
| False Statement Of Information   | 18   | False statement of information (הצהרת מידע כוזב). Relevant only if was requested by your Account Manager |
| Company Logo                   | 23   | Company logo image. Relevant only if was requested by your Account Manager |
|Driving License                 | 24   | Driving license (רישיון נהיגה). Relevant if you are onboarding sellers for Keep services.|
|Social ID Appendix             | 25 | Social ID Appendix (ספח תעודת זהות). Relevant if you are onboarding sellers for Keep services.|
|Passport              | 26   | Passport (דרכון). Relevant if you are onboarding sellers for Keep services.|
|Origin Tax Confirmation              | 27   | Origin Tax Confirmation (אישור ניכוי מס במקור). Relevant if you are onboarding sellers for Keep services.|
|Bookkeeping Certificate            | 28   | Bookkeeping Certificate  (אישור ניהול ספרים). Relevant if you are onboarding sellers for Keep services.



#### **Notes**

**Note 1:** It is possible to send all files in one call or one-by-one. At least one file is required in every call.

**Note 2:** File extension in file name is mandatory. Allowed file extensions: `pdf`, `jpg`, `jpeg`, `png`, `bmp`, `tiff`, `doc`, `docx`.

**Note 3:** Until we obtain and verify the 3 mandatory documents <br>(`Social Id`, `Bank`, `Corporate Certificate`), funds will not be available for withdrawal to the Seller's bank account.

+ Attributes (Upload Seller Files Request)

+ Request (application/json)

        {
            "payme_client_key": "XXXXXXXX",
            "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
            "seller_files": [
                {
                    "name": "dummy.pdf",
                    "type": 1,
                    "url": "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
                    "mime_type": "application/pdf"

                },
                {
                    "name": "test.png",
                    "type": 2,
                    "base64": "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAAAklEQVR4AewaftIAAAkOSURBVO3BabDdZWEH4OecXKUUQeAmYRGtW2lLRVBIUkNhJgI6shgWW1nUCJgmpRMoEATNQLmFRtZWIhJEqLLHChkEKYsKKTTQkOgkECgoCtqyhL0hjEswtx/eD3/PnHO3JPeac8/veURERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERLShmvhdt+BgPIhJWpuMxRotwhTD5xHsgutxtNY+g6s0ugLTDZ9f4804G2dq7R9xhkZfwLnaQF0MxbuwWLPb/X7tj6s0u8Pv10ycodnt2kSXGIqTVbbHKpuGkxWv4y02HScrVmB3baguhmKS4hassumYpPiaTUc3/ljxNW2qLoaiW/GMTUcN2yiesenYVuVZbaouflevwek1snr1rabSa2T16ltNpVeb6tLeTsGFKtfi0wZ2Gs5V2RUr8ZqNYz5mqpyFHgO7HNNV/hC/xBobx13YX+VTuM7A7sYUxdPYSbEGmxnFatrTHlimb9/CEZrth+9p7SXciBl4EJNUHsOfaG0hDld8Egv0bS7maDYT87W2BGuwL67H0SpvYIzWzsdpijk4R9+OxTc0uwCztXYd9sI7cTbOVLwLP9O3Gbhcm+jSnu5VvIxulYtwMtZq9mF8T+VsnKlYhj0ww/rbEQsUSzFR5Tv4ONZq9jeYrzINVytexSQbZh+co7gBR6k8gl2wVrPzMVtlL9yPsXgBR+sANe3nMNyk2B6rDM6L6Fa8Fas12gJrFA9ikmY/xbsxH8dr9HmchzXY0uBsjVcUL2C8ZrthueJ6HK1RHb9VnIJ/1uhyTMdyfMDg7ImligcwWbNP4NuKs3GmRjvjccUh+I42VNd+xinWYpXB+Ry6FUdgtWav41brb5ziFwbvdJUDtLYCj1p/4xT/a/BOUzlAazfiN0a5uvazQvEmzDc4hymex7cMjxWKXXCKwTlUsRjLDI8VioMw1eAcprgar+pgde3nv3ClYiZ6cbH+7a5YZPhci0WKC9GLE/RtC+ysuNfwOQtPK25GLw7Qt/ejrvgPHa5Le/ocluMrihNwgmJbvKLRWMWzhtcUfBknKi7GxXgJYzUaq/KM4bUTvosDFbcpluAvNBqn8qwOV9e+LkENu2r0Ms7XaJ1ijOH396jhUJVu9GKGyjqVuuF3EGqYrTIJvdhXZZ3KGB2urv2tRA01PKc4FR9VeVHxNiPnZtTwFpXL8F7Fiyo7GTkXoYbdVb6v8oLKjjpc3eiyA55XHKLy34rJRt7r2EplquKXeEox2chbgQ+qTFU8pjJZh6sbfR5W/IHKnYrtcLi+bWt4vIafKzZXuVOxF3bTt27D42GVzRVv4PuKadhCa1vizUa5uvZzHHq1Ng77KpaqXKxyI7o1ewR7WX9fwhNa+xD+SLFMZZ7KPVr7Nbaz/r6NO7R2pMoylXkq92j2DqzWAbq0l7fjCkWv4jO4BrfiIMUqXKqyFtNwleJFrc3CVwzdFJyu6FVMxgN4FH+mWIw7VB7F2TgD26BXa+fj84ZuOj6h6FVsh+exFl2Kq/GEyq24HkdhAnq1dhsONIqN0V5Wowc7YE/FoTgLOyueww6arcByHKG1HbEN/hpP4wrNTsQ2WIbbVJ5CD/bGuxXH4SyMU/wn9tbsHqzBRzR7HZthD+yHh7FQoxr+QXEXHlD5EXpwDLZWnIqzUFd8E5/VbCG2wwTNHsL2mIIP4l7co1E3ZikW4HEREREREREREREREREREREREaNXTee6DkdhDuYa2OWYrtFtOEj/puJmrV2OGQbveYzDRCw1sCfxTo1OxDz9uwR/p7W/wo06RE1nmYglGs3BXH37EO7Xvz3xQ80exAT9+yH21Lcv4p80moil+nYmevTtZXRr9la8amDn4gs6QJfOcSrONzRH4nrFo/hzld2wXLEEXRq9CRMU++JujS7CydgDx+NSze7C/obmShyrmIcTVWbjAmyL2/ExjfZSrMMYzR7Crjgd38CPjXJjdI770YMe9OCLGIO7cZ/WfoNZmIMjNVqFWzEDdbyGB1TW4SbMws80uwszsCW6cK1m16AHPViEzyq+jme0thMOxERcqdH9+BX2w3uxEM+r/ASr8TGt3YfjFT/HA0a5uujPj1HDXK39CIsV+2i2Euv0bblivI3nUtSwVGuXqOyt2b/o20q8oRivA9TFhvqJYqyhG6tYZeS8jqcV4w3NNuhSrNIB6mJDbaV4zdB8ABMUC42srRSrDc10lYU6QJfYUB9WLDF4h2Kh4t/xdSNnArZULDF4l+JvFSfhKR2gS2yIY7G14ip9ew+e0GwO5hpZJymewGJ9m4n5mk3EUh2iLjbEJYqr8aShe8zI+kscqeixfh7XQbrE+roBmytm6N9PUVN5FtvjJryGrYyMmxX34Vr9uwyXKXbFQ4r/w0IcrgPUxfqYhSMUn8SvDM0OqOG32BJLDL9b0K2YamgeRg37Kg7DOTpAXQzVRzBPMQ//Zv1NVUzEPobPBThYcTBesX7uxsWK2TpAXQzF+3Gn4gc40YZZpLKH4XEKZitOx3dtmEWKzfA+o1xdDNZ7sELxOPaz4cao1G18M3Gh4hKcZ8ONUakb5epiMHbCE4qX8KcG9g7M1r8DVFbauI7BfMUCzDKw47Cb/h2gstIo1yUGsgP+R/EGxhqc+/E27I+PavZ23KD4Be608Xwa/6q4HUca2C64QnEqLtTsGByruBLrjHI1neFoXGtwTsKXFdvhOZUjsEDffoD9FMfjqwZnd6zQ6JuYZnDeh0cUn8I1invxJKbp2+k4T3EzphrYCxivA9RFf76k0QKDdylqWKtvb6CGFTaeuSr7YJrBOwRT9O92jBcRERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERETGa/D8Rm8iOzF+WUQAAAABJRU5ErkJggg==",
                    "mime_type": "image/png"
                }
            ]
        }


+ Response 200 (application/json)
    + Attributes (object)
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)

    + Body
    
            {
              "status_code": 0
            }

## Withdraw Balance [/withdraw-balance]

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/withdraw-balance` |
| Production    | `https://live.payme.io/api/withdraw-balance` |

+ Attributes (Withdraw Balance Request)

### Withdraw Balance [POST]

#### <a name="withdrawal-notification-types"></a> Withdrawal Callback Notification Types
| Notification      | Description   |
|:------------------|:--------------|
| `withdrawal-complete`   | A withdrawal was completed successfully |

#### Callback
| Attribute             | Description  |
|:----------------------|:-------------|
| status_code           | `0` Status of the request (0 - success, 1 - error) |
| notify_type           | `withdrawal-complete` |
| seller_payme_id       | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` |
| tran_payme_code       | `123456` Our unique Withdrawal code |
| tran_created          | `2016-01-01 15:15:15` |
| tran_type             | `40` Financial Transaction type **[Bank Withdrawal](#financial-transaction-types)** |
| tran_currency         | `USD`        |
| tran_total            | `10000`      |
| tran_description      | `משיכה לבנק` |

+ Attributes (Withdraw Balance Request)

+ Request (application/json)
    + Attributes (Withdraw Balance Request)

+ Response 200 (application/json)
    + Attributes (object)
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)

    + Body
    
            {
              "status_code": 0
            }
            
+ Response 500 (application/json)
    + Attributes (object)
        + status_code: `1` (number) - Status of the request (0 - success, 1 - error)
        + status_error_details: `אין יתרה זמינה למשיכה` (string) - Error message
        + status_additional_info (string) - Additional error information
        + status_error_code: `171` (number) - Our unique error code 

    + Body
    
            {
              "status_code": 1,
              "status_error_details": "אין יתרה זמינה למשיכה",
              "status_additional_info": null,
              "status_error_code": 171
            }

# Group Sales
In order to achieve a seamless payment experience, we offer an IFRAME payment option, allowing the consumer a smooth payment experience, without ever leaving your website.

![GenerateSale](http://i.imgur.com/z2Pmwvs.png?1)

## Generate Sale [/generate-sale]

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/generate-sale` |
| Production    | `https://live.payme.io/api/generate-sale` |

#### **Notes**

**Note 1:** We allow you to manually set the number of installments or to specify a top limit of installments for the buyer to choose from while paying.

Setting a <u>fixed</u> number of installments is simply entering a number between 1 and 12.  The sale will be initiated with this number of installments and the buyer will not be able to change it.

To set a <u>range</u> for the buyer to choose from, enter the following:

`103` - allow up to 3 installments

`106` - allow up to 6 installments

`109` - allow up to 9 installments

`112` - allow up to 12 installments

#### <a name="md5-signature"></a> **MD5 Signature Creation**
MD5 signature allows you to have confidence in the transaction flow. In any case, verification of the transaction with the callback details is required to get enhanced assurance and fraud prevention.

Signature calculation (PHP example):
`$signature = md5($payme_client_key . $payme_merchant_secret . $payme_transaction_id . $payme_sale_id);`


#### <a name="sale-template"></a> **Template Sale**
Also known as “Multilink-Sale”. Enables payments on a single sale link, by multiple buyers. 
For example, you will be able to generate a single sale and share its payment link on any social network site to allow multiple customers to pay on their own.

**Note:** Every payment will create a new sale with a different ID.

Creation of a template sale should be done by adding the sale_type="template" attribute to the request:


| Attribute             | Description |
|:----------------------|:------------|
| sale_type             | `template` Creates a new sale as a template. The template sale link does not expire. |


#### <a name="sale-tokens"></a> **Using Tokens**
Please note that you can receive a token representing the buyer (including credit card information) as part of the generate-sale API call. This token can be used to generate future server-to-server sales without requiring the buyer to re-enter his credit card information.
The token will be returned only as part of the callback.

<u>Getting Tokens</u>

There are two ways of getting a token:

1. In order to receive a token **in addition to charging the credit card** use the `capture_buyer` attribute.
2. In order to receive a token **without charging the credit card** use the dedicated `sale_type` attribute and set the value to `token`.

| Attribute             | Description |
|:----------------------|:------------|
| capture_buyer         | `1` Flag for requesting the buyer's token in addition to charging the credit card (0 - do not capture token, 1 - capture token) |
| sale_type     | `token` Flag for requesting the buyer's token without charging the credit card |

<u>Charging Tokens</u>

After generating a token you may charge the buyer at any point by using the `buyer_key` attribute when generating a new sale.

| Attribute             | Description |
|:----------------------|:------------|
| buyer_key             | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Buyer key for an instant-payment with the token |

#### <a name="sale-authorize"></a> **Authorization**
Also known as “Pre-Authorization”. The requested amount gets reserved (blocked) on the credit card of the buyer for up to 168 hours. A following Capture request will trigger the actual settlement of the funds.
Please note that attempting to Capture after the allowed period of time (168 hours) will result in an error.

In order to authorize a payment a sale should be generated with the sale_type="authorize" parameter, and the returned IFRAME displayed to the buyer for credit card information filling.

| Attribute             | Description |
|:----------------------|:------------|
| sale_type             | `authorize` Creates a new sale as authorization. The authorization is reserved for up to 48 hours |

#### <a name="sale-capture"></a> **Capture**

When you decide to capture the authorized sale and charge the credit card, you can do so by using the API function
capture-sale.

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/capture-sale` |
| Production    | `https://live.payme.io/api/capture-sale` |

| Attribute         | Description |
|:------------------|:------------|
| payme_sale_id     | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique sale ID |
| sale_price        | `10000` Capturing sale final price. It can be lower or equal to the original price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075 |
| installments      | `1` (required, number) - Amount of installments for the sale.


+ Attributes (Generate Sale Request)

### Generate Sale [POST]

#### <a name="pre-fill"></a> **Pre-Fill payment page (IFRAME)**

You can pass your buyer's details to our payment page, to pre-fill the form. 

Simply concatenate the optional parameters to the end of the received `sale_url`.

These are the supported fields:
| Parameter     | Description |
|:--------------|:------------|
| first_name    | Card holder's first name |
| last_name     | Card holder's last name |
| phone         | Card holder's phone number |
| email         | Card holder's email address | 
| social_id     | Card holder's social ID - used for cards issued in Israel |
| zip_code      | Card holder's zip code - used for cards issued in USA, Canada and United Kingdom |

Here is an example of a pre-filled payment page:

`urlWithParameters = sale_url + "?first_name=First&last_name=Last&phone=0501234567&email=test@example.com`

**Note 1:** For security reasons, credit card information related fields cannot be pre-filled.

**Note 2:** Passed values which will be found invalid, won't be displayed on the form.

#### <a name="sale-success-redirect"></a> **Success Redirect (IFRAME)**
Once the sale is paid successfully, the buyer will be redirected to the provided `sale_return_url`, with the sale details as **GET** parameters. Example redirect URL:

`https://www.example.com/payment/success?payme_status=success&payme_signature=75e99dbcb25cdfbe1c62f0b9376f4144&payme_sale_id=XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX&payme_transaction_id=XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX&price=10000&currency=USD&transaction_id=12345&is_token_sale=0`

| Parameter         | Description |
|:------------------|:------------|
| payme_status      | `success` Status of the request (`success`, `error`) |
| payme_signature   | `75e99dbcb25cdfbe1c62f0b9376f4144` [MD5 Signature](#md5-signature) |
| payme_sale_id     | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique sale ID |
| payme_transaction_id | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique transaction ID | 
| price             | `10000` Sale final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075 |
| currency          | `USD` Sale currency. 3-letter ISO 4217 name |
| transaction_id    | `12345` Merchant's unique sale ID for correlation with us |
| is_token_sale     | `0` |

[//]: # (#### **Failure** \(IFRAME users only\))

[//]: # (In case the payment has failed, we will **redirect** the user to the `sale_error_url`, with the error details as **GET** parameters.)

[//]: # (Example:)
[//]: # (`https://www.example.com/payment/error?payme_status=error&cg_error=162&cg_error_text=תקרה+0+לסוג+כרטיס+זה+בעסקת+תשלומים&payme_sale_id=XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX&transaction_id=12345`)

[//]: # (| Parameter         | Description |)
[//]: # (|:------------------|:------------|)
[//]: # (| payme_status      | `error` Status of the request \(`success` - success, `error` - error\) |)
[//]: # (| cg_error          | `162` Error code |)
[//]: # (| cg_error_text     | `תקרה 0 לסוג כרטיס זה בעסקת תשלומים` Error message |)
[//]: # (| payme_sale_id     | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique sale ID |)
[//]: # (| transaction_id    | `12345` Merchant's unique sale ID for correlation with us |)

#### <a name="sale-callback"></a> **Callbacks**

Once the sale is paid successfully, we will notify the marketplace with the sale details with a **POST** of type `x-www-form-urlencoded` request to the marketplace **Callback URL**.

| Attribute             | Description |
|:----------------------|:------------|
| status_code           | `0` Status of the request (0 - success, 1 - error) |
| status_error_code     | In case of an error, our unique error code |
| status_error_details  | In case of an error, the error message |
| notify_type           | `sale-complete` [Sale notification types](#sale-notification-types) |
| sale_created          | `2016-01-01 15:15:15` |
| transaction_id        | `12345` Merchant's unique sale ID for correlation with us |
| payme_sale_id         | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique sale ID |
| payme_sale_code       | `12345678` Our unique sale code (for display purposes only) |
| payme_transaction_id  | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique transaction ID |
| price                 | `1000` Sale final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075 |
| currency              | `USD` Sale currency. 3-letter ISO 4217 name |
| sale_status           | `completed` [Sale statuses](#sale-statuses) |
| payme_transaction_card_brand  | `Visa` |
| payme_transaction_auth_number | `01A2B3C` Sale authorization number from the credit company |
| buyer_card_mask       | `458045******4580` Buyer's credit card mask |
| buyer_card_exp        | `0118` Buyer's credit card expiry date |
| buyer_name            | `First Last` Buyer's full name |
| buyer_email           | `buyer@example.com` Buyer's eMail address |
| buyer_phone           | `0540000000` Buyer's phone number |
| buyer_social_id       | `000000001` Buyer's social id |
| buyer_key             | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Buyer key for future token payments. This key is returned only if `capture_buyer` attribute was set in the request ([Using Tokens](#sale-tokens)) |
| installments          | `1` Amount of installments for the sale |
| sale_paid_date        | `2016-01-01 15:16:15` |
| sale_release_date     | `2016-01-08 15:15:15` |
| is_token_sale         | `0` (0 - false, 1 - true) |
| payme_signature       | `75e99dbcb25cdfbe1c62f0b9376f4144` |
| sale_invoice_url      | `https://www.example.com/XXXXXX.pdf` Sale invoice URL, if the seller has enabled the invoices module in his account panel |

[//]: # (| sale_invoice_number   | `3210` Sale invoice number, if the seller has enabled the invoices module in his account panel |)

#### <a name="sale-statuses"></a> Sale Statuses
| Status            | Description   |
|:------------------|:--------------|
| `initial`         | Creation status, a payment was not attempted |
| `completed`       | The sale was paid successfully |
| `refunded`        | The sale was fully refunded |
| `partial-refund`  | The sale was partially refunded |
| `authorized`      | The sale was authorized successfully |
| `voided`          | The authorization was fully voided |
| `partial-void`    | The authorization was partially voided |
| `failed`          | There was an error with the sale |
| `chargeback`      | The sale was chargedbacked |

#### <a name="sale-notification-types"></a> Sale Callback Notification Types
| Notification             | Description                          |
|:-------------------------|:-------------------------------------|
| `sale-complete`          | The sale was paid successfully       |
| `sale-authorized`        | The sale was authorized successfully |
| `refund`                 | The sale was refunded                |
| `sale-failure`           | There was an error with the sale     |
| `sale-chargeback`        | The sale was chargebacked            |
| `sale-chargeback-refund` | The chargeback was reverted          |

+ Attributes (Generate Sale Request)

+ Request (application/json)
    + Body

            {
                "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                "sale_price": 10000,
                "currency": "USD",
                "product_name": "Baby Duck",
                "transaction_id": "12345",
                "installments": 1,
                "sale_callback_url": "https://www.example.com/payment/callback",
                "sale_return_url": "https://www.example.com/payment/success",
                "capture_buyer": 0
            }

+ Response 200 (application/json)
    + Attributes (object)
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        + sale_url: `https://sandbox.payme.io/sale/generate/XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` - The URL of the IFRAME secured payment form to display to the buyer
        + payme_sale_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique sale ID
        + payme_sale_code: `12345678` (number) - Our unique sale code (for display purposes only)
        + price: `10000` (number) - Sale final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075
        + transaction_id: `12345` (string) - Merchant's unique sale ID for correlation with us
        + currency: `USD` (string) - Sale currency. 3-letter ISO 4217 name
            
+ Response 500 (application/json)
    + Attributes (object)
        + status_code: `1` (number) - Status of the request (0 - success, 1 - error)
        + status_error_details: `קישור משתמש לא נמצא` (string) - Error message
        + status_additional_info (string) - Additional error information
        + status_error_code: `251` (number) - Our unique error code 

    + Body
    
            {
              "status_code": 1,
              "status_error_details": "קישור משתמש לא נמצא",
              "status_additional_info": null,
              "status_error_code": 251
            }

## Refund Sale [/refund-sale]

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/refund-sale` |
| Production    | `https://live.payme.io/api/refund-sale` |

#### **Notes**

**Note 1:** It is possible to partially refund a single sale an unlimited amount of times.

+ Attributes (Refund Sale Request)

### Refund Sale [POST]

#### **Callback**

Once the sale is refunded successfully, we will update the marketplace with the sale details with a **POST** request of type `x-www-form-urlencoded` to the marketplace **Callback URL**.

[Callback Attributes](#sale-callback)

+ Attributes (Refund Sale Request)

+ Request (application/json)
    + Attributes (Refund Sale Request)

+ Response 200 (application/json)
    + Attributes (object)
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        + status_error_code: `0` (number) - Our unique error code
        + refunded_from_creditcard: `false` (boolean) - Return true if seller has not enough money for refund and we complete the refund from the seller credit card
        + sale_invoice_url: `https://www.example.com/XXXXXX.pdf` (string) - Sale invoice URL, if the seller has enabled the invoices module in his account panel
        + sale_refund_buffer: `8000` (number) - The refund buffer of this sale
        + sale_status: `refunded` (string) - Refund status. All available **[Sale statuses](#sale-statuses)**
        + payme_transaction_total:  `2000` (number) - The refund amount that the buyer will get
        + payme_transaction_total_aft_deduction:  `2000` (number) - The amount that the seller will be charge.
        + payme_transaction_id:  `XXXXXX-XXXXXX-XXXXXX-XXXXXX` (string) - The transaction unique id.
        + payme_transaction_card_brand: `XXXXXX` (string) - Card brand
        + payme_transaction_auth_number: `XXXXXX` (string) - Authorization number from credit company
        
    + Body
    
            {
                "status_code": 0,
                "status_error_code": 0,
                "refunded_from_creditcard": false,
                "sale_invoice_url": null,
                "sale_refund_buffer": 8000,
                "sale_status": "refunded",
                "payme_transaction_total": 2000,
                "payme_transaction_total_aft_deduction": 2000,
                "payme_transaction_id": "XXXXXX-XXXXXX-XXXXXX-XXXXXX",
                "payme_transaction_card_brand": "Isracard",
                "payme_transaction_auth_number": "1192457"
            }
            
+ Response 500 (application/json)
    + Attributes (object)
        + status_code: `1` (number) - Status of the request (0 - success, 1 - error)
        + status_error_details: `Could not access sale` (string) - Error message
        + status_additional_info (string) - Additional error information
        + status_error_code: `303` (number) - Our unique error code

    + Body
    
            {
              "status_code": 1,
              "status_error_details": "Could not access sale",
              "status_additional_info": null,
              "status_error_code": 303
            }

# Group Subscription
We provide an easy way to allow API subscription generation. A subscription allows the seller to create a recurring payment for pre-defined payments over a set of iterations in days/weeks/months (e.g. 100 USD for 10 months, which totals to 1000 USD).

The Subscription, unlike an installment sale, does not authorize for the entire subscription amount upfront (e.g. 1000 USD per previous example), but it only captures the single payment amount each month.

![GenerateSale](http://i.imgur.com/jf9lmr8.png)

## Generate Subscription [/generate-Subscription]

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/generate-subscription` |
| Production    | `https://live.payme.io/api/generate-subscription` |

+ Attributes(Generate Subscription Request)

### Generate Subscription [POST]

#### <a name="subscription-template"></a> **Template Subscription**
Also known as “Multilink-Subscription”. Enables payments on a single subscription link, by multiple buyers. 
For example, you will be able to generate a single subscription and share its payment link on any social network site to allow multiple customers to pay on their own.

**Note:** Every payment will create a new subscription with a different ID.

Creation of a template subscription should be done by adding the sub_type="template" attribute to the request:


| Attribute             | Description |
|:----------------------|:------------|
| sub_type             | `template` Creates a new subscription as a template. The template subscription link does not expire. |


#### <a name="subscription-callback"></a> **Callbacks**

We provide the option to notify of any status or action updates regarding the subscription. To use the feature it is required to provide a **sub_callback_url** parameter to the `generate-subscription` call. This URL will receive all callbacks using a **POST** request of type `x-www-form-urlencoded`.

![Subscription life cycle](http://i.imgur.com/WgYqJ2b.png?1)

| Attribute                 | Description |
|:--------------------------|:------------|
| notify_type               | `sub-iteration-success` [Subscription notification types](#subscription-notification-types) |
| status_error_code         | In case of an error, our unique error code |
| sub_error_text            | In case of an error, the error message |
| status_code               | `0` Status of the request (0 - success, 1 - error) |
| seller_payme_id           | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique seller ID |
| seller_id                 | `12345` (string) - Merchant's unique seller ID for correlation with us |
| sub_payme_id              | `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique Subscription ID |
| sub_payme_code            | `1234` (number) - Our unique Subscription code |
| sub_created               | `2016-01-01 15:15:15` (string) - Subscription creation date and time. ISO-8601 formatted |
| sub_payment_date          | `2016-01-01 18:32:23` (string) - Subscription payment date and time. ISO-8601 formatted  |
| sub_start_date            | `2016-01-02 00:00:00` (string) - Subscription date and time when the first iteration was executed. ISO-8601 formatted |
| sub_next_date             | `2016-01-03 00:00:00` (string) - Subscription next iteration date and time. ISO-8601 formatted |
| sub_status                | `1` (string) - Subscription status [Subscription Statuses Types](#subscription-statuses) |
| sub_iteration_type        | `1` (number) - Subscription type [Subscription Iteration Types](#subscription-iteration-types) |
| sub_currency              | `USD` (string) - Subscription currency. 3-letter ISO 4217 name |
| sub_price                 | `10000` (number) - Subscription final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075 |
| sub_iterations            | `4` (number) - Amount of iterations |
| sub_iterations_completed  | `4` (number) - Amount of completed iterations |
| sub_iterations_left       | `4` (number) - Amount of remaining iterations |
| buyer_card_mask           | `458045******4580` (string) - Buyer's credit card mask |
| buyer_name                | `First Last` (string) - Buyer's full name |
| buyer_email               | `buyer@example.com` (string) - Buyer's eMail address |
| buyer_phone               | `0540000000` (string) - Buyer's phone number |
| buyer_social_id           | `000000001` (string) - Buyer's social id |

#### <a name="subscription-iteration-types"></a> **Subscription Iteration Types**
| ID    | Description   |
|:-----:|:--------------|
| `1`   | Daily         |
| `2`   | Weekly        |
| `3`   | Monthly       |
| `4`   | Yearly        |

#### <a name="subscription-statuses"></a> **Subscription Statuses**
| ID    | Description                     |
|:-----:|:--------------------------------|
| `1`   | Initial (not yet paid)          |
| `2`   | Active (paid successfully)      |
| `4`   | Failed                          |
| `5`   | Canceled                        |
| `6`   | Completed                       |
| `7`   | Failed, pending automatic retry |

#### <a name="subscription-notification-types"></a> Subscription Callback Notification Types
| Notification               | Description   |
|:---------------------------|:--------------|
| `sub-create`               | The subscription was created |
| `sub-active`               | The subscription was paid |
| `sub-iteration-success`    | Subscription iteretion passed successfully |
| `sub-complete`             | The subscription's iteretations have reached its predetermined max and finished  |
| `sub-cancel`               | The subscription was canceled |
| `sub-failure`              | An error happened and the subscription payment was failed |

+ Attributes(Generate Subscription Request)

+ Request (application/json)
    + Attributes(Generate Subscription Request)
    
+ Response 200 (application/json)
    + Attributes (object)
        + sub_url: `https://sandbox.payme.io/subscription/generate/XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`
        + status_code: 0
        + payme_status: `success`
        + status_error_code: 0
        + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`
        + seller_id: `XXXXXX`
        + sub_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`
        + sub_payme_code: 1
        + subscription_id: null
        + sub_created: `2016-09-08 18:11:13`
        + sub_start_date: `2016-11-05 15:04:23`
        + sub_prev_date: null
        + sub_next_date: `2016-11-05 15:04:23`
        + sub_status: 1
        + sub_iteration_type: `3`
        + sub_currency: `USD`
        + sub_price: `500`
        + sub_description: `Subscription for something`
        + sub_iterations: `12`
        + sub_iterations_completed: 0
        + sub_iterations_left: `12`
        + sub_paid: false
        + sub_error_text: null

## Cancel Subscription [/cancel-Subscription]

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/cancel-subscription` |
| Production    | `https://live.payme.io/api/cancel-subscription` |

+ Attributes(Cancel Subscription Request)

### Cancel Subscription [POST]

+ Attributes(Cancel Subscription Request)

+ Request (application/json)
    + Attributes(Cancel Subscription Request)
    
+ Response 200 (application/json)
    + Attributes (object)
        + status_code: 0

# Group Queries
It is possible to query the system for data, using your unique `payme_client_key`.

## Query Sellers [/get-sellers]
Every attribute can also receive an `array` of values, for a multi-value search.

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/get-sellers` |
| Production    | `https://live.payme.io/api/get-sellers` |

+ Attributes (Get Sellers Request)

### Get Sellers [POST]

+ Attributes (Get Sellers Request)

+ Request (application/json)

        {
            "payme_client_key": "XXXXXXXX",
            "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
            "seller_created_min": "2016-01-01 00:00:00",
            "seller_created_max": "2016-01-02 00:00:00",
            "seller_first_name": "First"
        }

+ Response 200 (application/json)
    + Attributes (object)
        + items_count: `1` (number) - Amount of returned items
        + items (array) - The returned items
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        

    + Body
    
            {
                "items_count": 1,
                "items": [
                {
                  "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                  "seller_id": "12345",
                  "seller_created": "2016-01-01 15:15:15",
                  "seller_active": true,
                  "seller_approved": false,
                  "seller_approved_date": "2016-02-10 00:00:00",
                  "seller_is_paid_directly": false,
                  "seller_is_discount": true,
                  "seller_withdrawal_plan": 1,
                  "seller_withdrawal_date": null,
                  "seller_personal_details": {
                    "seller_first_name": "First",
                    "seller_last_name": "Last",
                    "seller_social_id": "999999999",
                    "seller_birthdate": "1989-05-06",
                    "seller_gender": "1",
                    "seller_email": "personal@example.com",
                    "seller_phone": "0540123456"
                  },
                  "seller_business_details": {
                    "seller_inc": "2",
                    "seller_inc_code": "123456",
                    "seller_merchant_name": "Baby Ducks",
                    "seller_site_url": "www.babyducks.com",
                    "seller_description": "We are Baby Ducks",
                    "seller_retail_type": "1",
                    "seller_contact_email": "contact@example.com",
                    "seller_contact_phone": "031234567",
                    "seller_bank_account_code": "12",
                    "seller_bank_account_branch": "123",
                    "seller_bank_account_number": "12345"
                  },
                  "seller_address": {
                    "seller_address_city": "City",
                    "seller_address_street": "Street",
                    "seller_address_street_number": "10",
                    "seller_address_country": "IL"
                  },
                  "seller_fees": {
                    "fee_market_fee": "1.50",
                    "fee_default_processing_fee": "2.50",
                    "fee_default_processing_charge": "1.20",
                    "fee_default_discount_fee": "0.50",
                    "fee_foreign_processing_fee": "3.50",
                    "fee_foreign_processing_charge": "1.20",
                    "fee_forcurr_processing_charge": "0.30"
                  },
                  "seller_currencies": [
                    "ILS",
                    "USD",
                    "EUR"
                  ],
                  "seller_wallets": {
                    "ILS": {
                      "wallet_currency": "ILS",
                      "wallet_total": "10000",
                      "wallet_releasable": "0"
                    },
                    "USD": {
                      "wallet_currency": "USD",
                      "wallet_total": "0",
                      "wallet_releasable": "0"
                    }
                  },
                  "seller_monthly_invoices": {
                    "1234": {
                      "invoice_reference": "2015-12",
                      "invoice_created": "2016-01-01",
                      "invoice_doc_number": "1234",
                      "invoice_url": "PDF_FILE_URL.pdf",
                      "invoice_details_url": "https://sandbox.payme.io/system/invoice-details-viewer/XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
                    },
                    "2134": {
                      "invoice_reference": "2016-01",
                      "invoice_created": "2016-02-01",
                      "invoice_doc_number": "2134",
                      "invoice_url": "PDF_FILE_URL.pdf",
                      "invoice_details_url": "https://sandbox.payme.io/system/invoice-details-viewer/XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
                    }
                  }
                }
                ],
                "status_code": 0
            }

## Query Sales [/get-sales]
Every attribute can also receive an `array` of values, for a multi-value search.

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/get-sales` |
| Production    | `https://live.payme.io/api/get-sales` |

+ Attributes (Get Sales Request)

### Get Sales [POST]

+ Attributes (Get Sales Request)

+ Request (application/json)

        {
            "payme_client_key": "XXXXXXXX",
            "transaction_id": "12345"
        }

+ Response 200 (application/json)
    + Attributes (object)
        + items_count: `1` (number) - Amount of returned items
        + items (array) - The returned items
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        

    + Body
    
            {
              "items_count": 1,
              "items": [
                {
                  "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                  "seller_id": "12345",
                  "sale_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                  "sale_payme_code": "12345678",
                  "transaction_id": "12345",
                  "sale_created": "2016-01-01 15:15:15",
                  "sale_status": "completed",
                  "sale_currency": "USD",
                  "sale_price": 10000,
                  "sale_price_after_fees": 8970,
                  "sale_description": "A duck",
                  "sale_installments": 1,
                  "sale_vat": "0.17",
                  "sale_paid_date": "2016-01-01 15:16:15",
                  "sale_auth_number": "01A2B3C",
                  "sale_release_date": "2016-01-08 15:15:15",
                  "sale_error_code": "",
                  "sale_error_text": "",
                  "sale_fees": {
                    "sale_processing_fee": "3.50",
                    "sale_processing_charge": "1.20",
                    "sale_discount_fee": "0.50",
                    "sale_rapid_settlement_fee": "0.30",
                    "sale_market_fee": "0.00"
                  },
                  "sale_buyer_details": {
                    "buyer_card_mask": "458045******4580",
                    "buyer_card_expiry": "1022",
                    "buyer_card_brand": "Visa",
                    "buyer_card_is_foreign": true,
                    "buyer_name": "First Last",
                    "buyer_email": "buyer@example.com",
                    "buyer_phone": "0540000000",
                    "buyer_social_id": "000000001"
                  },
                  "sale_invoices": []
                }
              ],
              "status_code": 0
            }

## Query Subscriptions [/get-subscriptions]
Every attribute can also receive an `array` of values, for a multi-value search.

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/get-subscriptions` |
| Production    | `https://live.payme.io/api/get-subscriptions` |

#### **Subscription Iteration Types**
| ID    | Description   |
|:-----:|:--------------|
| `1`   | Daily         |
| `2`   | Weekly        |
| `3`   | Monthly       |
| `4`   | Yearly        |

#### **Subscription Statuses**
| ID    | Description                     |
|:-----:|:--------------------------------|
| `1`   | Initial (not yet paid)          |
| `2`   | Active (paid successfully)      |
| `4`   | Failed                          |
| `5`   | Canceled                        |
| `6`   | Completed                       |
| `7`   | Failed, pending automatic retry |

+ Attributes (Get Subscriptions Request)

### Get Subscriptions [POST]

+ Attributes (Get Subscriptions Request)

+ Request (application/json)

        {
            "payme_client_key": "XXXXXXXX",
            "sub_payme_code": "1234"
        }

+ Response 200 (application/json)
    + Attributes (object)
        + items_count: `1` (number) - Amount of returned items
        + items (array) - The returned items
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        

    + Body
    
            {
              "items_count": 1,
              "items": [
                {
                  "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                  "seller_id": "12345",
                  "sub_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                  "sub_payme_code": "1234",
                  "sub_created": "2016-01-01 15:15:15",
                  "sub_start_date": "2016-01-10 08:00:00",
                  "sub_prev_date": null,
                  "sub_next_date": null,
                  "sub_status": "2",
                  "sub_iteration_type": "3",
                  "sub_price": "10000",
                  "sub_description": "Monthly Test Subscription",
                  "sub_iterations": "4",
                  "sub_iterations_completed": "0",
                  "sub_iterations_left": "4",
                  "sub_payment_date": "2016-01-02 10:10:10",
                  "sub_error_text": "",
                  "sub_currency": "USD",
                  "sub_paid": true,
                  "sub_buyer_details": {
                    "buyer_card_mask": "458045******4580",
                    "buyer_name": "First Last",
                    "buyer_email": "buyer@example.com",
                    "buyer_phone": "0540000000",
                    "buyer_social_id": "000000001"
                  }
                }
              ],
              "status_code": 0
            }

## Query Withdrawals [/get-withdrawals]
Every attribute can also receive an `array` of values, for a multi-value search.

#### **Target URLs**
| Environment   | URL           |
|:--------------|:--------------|
| Staging       | `https://sandbox.payme.io/api/get-withdrawals` |
| Production    | `https://live.payme.io/api/get-withdrawals` |

+ Attributes (Get Withdrawals Request)

### Get Withdrawals [POST]

+ Attributes (Get Withdrawals Request)

+ Request (application/json)

        {
            "payme_client_key": "XXXXXXXX",
            "withdrawal_payme_code": "1234"
        }

+ Response 200 (application/json)
    + Attributes (object)
        + items_count: `1` (number) - Amount of returned items
        + items (array) - The returned items
        + status_code: `0` (number) - Status of the request (0 - success, 1 - error)
        

    + Body
    
            {
                "items_count": 1,
                "items": [
                    {
                        "seller_payme_id": "XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX",
                        "withdrawal_payme_code": 10001,
                        "withdrawal_created": "2016-01-01 15:15:15",
                        "withdrawal_currency": "USD",
                        "withdrawal_total": 600000,
                        "withdrawal_description": "משיכה לבנק"
                    }
                ],
                "status_code": 0
            }

# Group Integrations
We provide the following integrations options for easely connecting to our services.

## Hosted Fields - JSAPI
A fully PCI compliant way for you to design you own payment page, without the need to be PCI compliant!

You can start by visiting our [examples page](https://paymeservice.github.io/payme-jsapi/) for a quick start.

The full documentation can be found [here](https://github.com/PayMeService/payme-jsapi).

## IFRAME
In order to achieve a seamless payment experience, we offer an IFRAME payment option, allowing the consumer a smooth payment experience, without ever leaving your website.
![IFRAME integration](http://i.imgur.com/z2Pmwvs.png?1)

## Android SDK
Android SDK is open source, you can see instructions and more info in the [project repositiry](https://bitbucket.org/paymeservice/isracard-global-android-sdk).

## iOS SDK
iOS SDK is open source, you can see instructions and more info in the [project repository](https://bitbucket.org/paymeservice/isracard-global-ios-sdk).

## Direct API
If you are PCI compliant and would like to use our Direct credit card API, please [contact us](http://www.payme.io).


## Data Structures

### Create Seller Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_id: `12345` (string) - Merchant's unique seller ID for correlation with us. This must be a unique number, or null.
    + seller_first_name: `First` (required, string) - First name of the account owner
    + seller_last_name: `Last` (required, string) - Last name of the account owner
    + seller_social_id: `999999999` (required, string) - Social ID of the account owner
    + seller_birthdate: `06/05/1989` (required, string) - Seller’s birth date. DD/MM/YYYY formatted
    + seller_social_id_issued: `01/01/2000` (required, string) - Seller’s social ID issue date. DD/MM/YYYY formatted
    + seller_gender: `0` (required, number) - Seller’s gender (0 - Male, 1 - Female)
    + seller_email: `personal@example.com` (required, string) - Seller's personal email
    + seller_contact_email: `contact@example.com` (string) - Seller's contact email that will be displayed to the buyers. If not stated, will be copied from seller_email
    + seller_phone: `0540123456` (required, string) - Seller's personal mobile phone number (not a landline number)
    + seller_contact_phone: `031234567` (string) - Seller's contact phone number that will be displayed to the buyers. If not stated, will be copied from seller_phone
    + seller_bank_code: `54` (required, number) - Seller's bank code (Israeli only). **[Valid bank codes list](#bank-codes-list)**
    + seller_bank_branch: `123` (required, number) - Seller's bank branch code
    + seller_bank_account_number: `123456` (required, number) - Seller's bank account number
    + seller_description: `An online store which specializes in rubber ducks` (required, string) - Seller’s description, including offered product line and services. Limited to 255 characters
    + seller_site_url: `www.babyducks.com` (required, string) - Seller’s site URL
    + seller_person_business_type: `2000` (required, string) - Seller business category code / MCC (for list of codes, see Note 1 below)
    + seller_inc: `2` (required, number) - Seller's incorporation type (0/1 - Private Individual/Sole Proprietorship, 2 - Licensed Company, 3 - Corporation, 4 - Registered Partnership, 5 - Exempt Company, 6 - Non Profit, 7 - LLC Limited Liability Company)
    + seller_inc_code: `123456` (string) - Seller's business ID (ח.פ, ע.מ), required when seller_inc is not 0
    + seller_registration_date: `06/05/2020` (required, string) - Seller’s business registration date. DD/MM/YYYY formatted
    + seller_retail_type: `1` (number) - Seller's retail type. (1 - Card not present (online) seller, 2 - Card present seller).
    + seller_merchant_name: `Baby Ducks` (string) - Seller's merchant name, required when seller_inc is not 0
    + seller_address_city: `Tel Aviv` (required, string) - Seller's business address - city
    + seller_address_street: `Rothschild` (required, string) - Seller's business address - street
    + seller_address_street_number: `45` (required, number) - Seller's business address - street number
    + seller_address_country: `IL` (required, string) - Seller's business address - country (ISO 3166-1 alpha-2 format). **[Country codes list](#country-codes-list)**
    + market_fee: `1.50` (number) - A decimal between 0.00 and 60.00 representing the percent of the sale price that is collected for the marketplace (includes VAT). This fee is added on top of our fees and transferred to the marketplace once a month. Default value is 0
    + language: `en` (string) - Changes the error message language to English. Default value is Hebrew (`he`)
    + seller_plan: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - A predefined set of settings for the seller. If required, this value will be provided by your Account Manager.

### Upload Seller Files Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique seller ID
    + seller_files: `[(File #1 object),(File #2 object),...]` (required, string) - Array of files according to the format described below
    + language: `en` (string) - Changes the error message language to English. Default value is Hebrew (`he`)

### Withdraw Balance Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique seller ID
    + withdrawal_currency: `USD` (required, string) - Withdrawal currency. 3-letter ISO 4217 name
    + language: `en` (string) - Changes the error message language to English. Default value is Hebrew (`he`)

### Generate Sale Request
+ Attributes (object)
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique seller ID
    + sale_price: `10000` (required, number) - Sale final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075. Note that the minimum value is **500**
    + currency: `USD` (required, string) - Sale currency. 3-letter ISO 4217 name
    + product_name: `Baby Duck` (required, string) - Short name and description of the product/service. This text will be shown in the invoice as well, if the seller has enabled the invoices module in his account panel. Limited to 500 characters
    + transaction_id: `12345` (string) - Merchant's unique sale ID for correlation with us
    + installments: `1` (required, number) - Amount of installments for the sale. For additional information see Note 1 below
    + market_fee: `2.50` (number) - A decimal between 0.00 and 60.00 representing the percent of the sale price that is collected for the marketplace (includes VAT). This fee is added on top of our fees and transferred to the marketplace once a month. Default value is the `market fee` of the Seller, as set upon Seller creation
    + sale_callback_url: `https://www.example.com/payment/callback` (string) - Callback response to your page regarding call to our API. Default value is taken from the Merchant's settings. Note that you may not send a "localhost" URL as value
    + sale_return_url: `https://www.example.com/payment/success` (string) - We will redirect the IFRAME and the buyer to this URL upon payment success. Default value is taken from the Merchant's settings
    + sale_send_notification: `true` (boolean) - Flag to send email and/or SMS notifications
    + sale_email: `duckshop@example.com` (string) - In case *sale send notification* is true provide the address to send email notification
    + sale_mobile: `123456789` (string) - In case *sale send notification* is true, provide the phone number to send SMS notification, if the seller has enabled the SMS module in his account panel
    + sale_name: `John` (string) - The name that will be displayed when sending a notification
    + capture_buyer: `0` (number) - Flag for requesting the buyer's token for this payment (0 - do not capture token, 1 - capture token). For additional information see Tokens explanation below
    + `buyer_key`: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Buyer key for an instant-payment with the token. This key is received through the use of capture_buyer. Note that this attribute cannot co-exist with the capture_buyer parameter in the same request
    + buyer_perform_validation: `true` (boolean) - Flag for performing an online validation of the card with the Issuer. Default value is true
    + sale_payment_method: `credit-card` (string) - Sale payment method. Available methods are: credit-card, bit, paypal, sepa, bacs, echeck, alipay-qr, funds-transfer. Default value is credit-card
    + layout: (string) - IFRAME payment page layout. Optional attribute which may be used with "bit" sale_payment_method. Available layouts are: dynamic, qr-sms. Default value is dynamic
    + language: `en` (string) - Changes the language of the payment IFRAME to English, as well as the error messages. Default value is Hebrew (`he`)

[//]: # (sale_error_url: `https://www.example.com/payment/error` (string) - We will redirect the IFRAME and the buyer to this URL upon payment failure. Default value is taken from the Merchant's settings)
[//]: # (sale_cancel_url: `https://www.example.com/payment/cancel` (string) - We will redirect to this URL in case user cancels the sale. This function is not in use at the moment, please provide the same URL as in sale_error_url)

### Refund Sale Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique seller ID
    + payme_sale_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` Our unique sale ID
    + sale_refund_amount: `10000` (number) - Used only for partial refunds, for a full refund exclude this attribute. Refund amount. For example, if the amount is 50.75 (max 2 decimal points) the value that recieved is 5075. Note that the minimum value is **500**.
    + language: `en` (string) - Changes the error message language to English. Default value is Hebrew (`he`)

### Generate Subscription Request
+ Attributes (object)
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique seller ID
    + sub_price: 500 (required, number) - A single iteration final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075. Note that the minimum value is **500**
    + sub_currency: `USD` (required, string) - Subscription currency. 3-letter ISO 4217 name
    + sub_description: `Subscription for something` (required, string) Subscription description. Limited to 300 characters
    + sub_iteration_type: `3` (string) - 1 - Daily, 2 - Weekly, 3 - Monthly, 4 - Yearly
    + sub_iterations: 12 (number) - If not set, creates an infinite subscription
    + sub_start_date: 1440354488 (required, string) - Format: DD/MM/YYYY or Epoch in seconds
    + sub_callback_url: `https://www.example.com/payment/callback` (string) - Callback response to your page regarding call to our API. Default value is taken from the Merchant's settings. Note that you may not send a "localhost" URL as value
    + sub_return_url: `https://www.example.com/payment/success` (string) - PayMe will redirect the IFRAME and the buyer to this URL upon payment success. Default value is taken from the Merchant's settings
    + buyer_key: `XXXXXXXX` (string) - A token you generated beforehand (If not provided, an iframe URL will be returned)
    + language: `en` (string) - Changes the error message language to English. Default value is Hebrew (`he`)

### Cancel Subscription Request
+ Attributes (object)
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique seller ID
    + sub_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (required, string) - Our unique subscription ID
    + language: `en` (string) - Changes the error message language to English. Default value is Hebrew (`he`)

### Get Sellers Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique seller ID
    + seller_id: `12345` (string) - Merchant's unique seller ID for correlation with us
    + seller_created: `2016-01-01 15:15:15` (string) - - Exact creation date and time for which to retrieve sellers. ISO-8601 formatted
    + seller_created_min: `2016-01-01 00:00:00` (string) - Earliest creation date and time for which to retrieve sellers. ISO-8601 formatted
    + seller_created_max: `2016-01-02 00:00:00` (string) - Latest date and time for which to retrieve sellers. ISO-8601 formatted
    + seller_first_name: `First` (string) - First name of the account owner
    + seller_last_name: `Last` (string) - Last name of the account owner
    + seller_social_id: `999999999` (string) - Social ID of the account owner
    + seller_email: `personal@example.com` (string) - Seller's personal email
    + seller_contact_email: `contact@example.com` (string) - Seller's contact email that will be displayed to the buyers
    + seller_phone: `0540123456` (string) - Seller's personal phone
    + seller_contact_phone: `031234567` (string) - Seller's contact phone that will be displayed to the buyers
    + seller_inc: `2` (number) - Seller's incorporation type (0/1 - Private Individual/Sole Proprietorship, 2 - Licensed Company, 3 - Corporation, 4 - Registered Partnership, 5 - Exempt Company, 6 - Non Profit, 7 - LLC Limited Liability Company)
    + seller_inc_code: `123456` (string) - Seller's business ID (ח.פ, ע.מ)
    + seller_merchant_name: `Baby Ducks` (string) - Seller's merchant name
    + fee_market_fee: `1.50` (number) - A decimal between 0-30 representing the percent of the sale price that is collected for the marketplace (includes VAT)
    + seller_active: `true` (boolean) - Seller's active state
    + seller_approved: `false` (boolean) - Seller's approval state

### Get Sales Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique seller ID
    + seller_id: `12345` (string) - Merchant's unique seller ID for correlation with us
    + sale_payme_code: `12345678` (number) - Our unique sale code
    + sale_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique sale ID
    + sale_created: `2016-01-01 15:15:15` (string) - Exact creation date and time for which to retrieve sales. ISO-8601 formatted
    + sale_created_min: `2016-01-01 00:00:00` (string) - Earliest creation date and time for which to retrieve sales. ISO-8601 formatted
    + sale_created_max: `2016-01-02 00:00:00` (string) - Latest date and time for which to retrieve sales. ISO-8601 formatted
    + sale_status: `completed` (string) - Sale status. All available **[Sale statuses](#sale-statuses)**
    + sale_price: `10000` (number) - Sale final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075
    + sale_currency: `USD` (string) - Sale currency. 3-letter ISO 4217 name
    + sale_auth_number: `01A2B3C` (string) - Sale authorization number from the credit company
    + buyer_card_mask: `458045******4580` (string) - Buyer's credit card mask
    + buyer_card_last_four_digits: `4580` (string) - Buyer's credit card last four digits
    + buyer_name: `First Last` (string) - Buyer's full name
    + buyer_email: `buyer@example.com` (string) - Buyer's eMail address
    + buyer_phone: `0540000000` (string) - Buyer's phone number
    + buyer_social_id: `000000001` (string) - Buyer's social id
    + buyer_card_is_foreign: `true` (boolean) - Is the buyer's credit card foreign

### Get Subscriptions Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique seller ID
    + seller_id: `12345` (string) - Merchant's unique seller ID for correlation with us
    + sub_payme_code: `1234` (number) - Our unique subscription code
    + sub_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique sub ID
    + sub_created: `2016-01-01 15:15:15` (string) - Exact creation date and time for which to retrieve subscriptions. ISO-8601 formatted
    + sub_created_min: `2016-01-01 00:00:00` (string) - Earliest creation date and time for which to retrieve subscriptions. ISO-8601 formatted
    + sub_created_max: `2016-01-02 00:00:00` (string) - Latest date and time for which to retrieve subscriptions. ISO-8601 formatted
    + sub_status: `1` (string) - Subscription status (for more info about the statuses, see table below)
    + sub_iteration_type: `1` (number) - Subscription type ID (for more info about the types, see table below)
    + sub_price: `10000` (number) - Subscription final price. For example, if the price is 50.75 (max 2 decimal points) the value that needs to be sent is 5075
    + sub_currency: `USD` (string) - Subscription currency. 3-letter ISO 4217 name
    + sub_iterations: `4` (number) - Subscription amount of iterations
    + sub_start_date: `2016-01-01 00:00:00` (string) - Exact start date and time for which to retrieve subscriptions. ISO-8601 formatted
    + sub_paid: `true` (boolean) - Was the subscription paid

### Get Withdrawals Request
+ Attributes (object)
    + payme_client_key: `XXXXXXXX` (required, string) - Your private key provided by us for authentication
    + seller_payme_id: `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` (string) - Our unique seller ID
    + seller_id: `12345` (string) - Merchant's unique seller ID for correlation with us
    + withdrawal_created: `2016-01-01 15:15:15` (string) - Exact creation date and time for which to retrieve withdrawals. ISO-8601 formatted
    + withdrawal_created_min: `2016-01-01 00:00:00` (string) - Earliest creation date and time for which to retrieve withdrawals. ISO-8601 formatted
    + withdrawal_created_max: `2016-01-02 00:00:00` (string) - Latest date and time for which to retrieve withdrawals. ISO-8601 formatted
    + withdrawal_total: `10000` (number) - Withdrawal total amount. For example, if the amount is 50.75 (max 2 decimal points) the value that recieved is 5075
    + withdrawal_currency: `USD` (string) - Withdrawal currency. 3-letter ISO 4217 name