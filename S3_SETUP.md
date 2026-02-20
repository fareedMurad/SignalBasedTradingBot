# AWS S3 Setup Guide

## 🔐 Required S3 Permissions

Your IAM user (the one associated with the API keys in `.env`) needs the following permissions to work with the **signal-trades** bucket.

### ⚡ Quick Option: Use Root User (Not Recommended for Production)

**Yes, you can use root user credentials and skip all the permission setup!**

Root user has full access to everything in AWS, so the bot will work immediately without any policy configuration.

**However:**
- ⚠️ **Security Risk**: If someone gets your root credentials, they can delete everything in your AWS account
- ⚠️ **Best Practice**: AWS strongly recommends NOT using root user for applications
- ✅ **Better**: Create an IAM user with limited permissions (just S3 access)

**If you want to use root credentials anyway:**
1. Login to AWS Console as root
2. Go to Security Credentials
3. Create Access Key
4. Put in `.env` file
5. Done! No permission setup needed.

### 🔒 Recommended Option: IAM User with Limited Permissions

For production/security, follow the steps below to create a proper IAM user:

### Quick Fix (AWS Console) - Step by Step

#### Step 1: Create the Policy First

1. **Go to IAM Policies**
   - Navigate to: https://console.aws.amazon.com/iam/
   - Click "Policies" in the left sidebar (NOT Users)
   - Click the blue "Create policy" button

2. **Switch to JSON Tab**
   - You'll see "Visual editor" and "JSON" tabs
   - Click "JSON" tab
   - Delete any existing text in the box

3. **Paste This Policy**
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:DeleteObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::signal-trades",
                "arn:aws:s3:::signal-trades/*"
            ]
        }
    ]
}
```

4. **Click Next: Tags**
   - Skip tags (optional)
   - Click "Next: Review"

5. **Name the Policy**
   - Policy name: `SignalTradesFullAccess`
   - Description: `Full access to signal-trades bucket for trading bot`
   - Click "Create policy"
   - You'll see "Policy created successfully" ✅

#### Step 2: Attach Policy to Your User

6. **Go to Users**
   - Click "Users" in the left sidebar
   - Find your IAM user (the one with Access Key: AKIAYTJNKYFJSR5FX7HT)
   - Click on the username

7. **Add Permissions**
   - Click "Add permissions" button (blue button)
   - Select "Attach policies directly"
   - In the search box, type: `SignalTradesFullAccess`
   - Check the box next to `SignalTradesFullAccess`
   - **DO NOT** select from the 1447 existing policies list
   - Click "Next"
   - Click "Add permissions"

8. **Verify**
   - You should see `SignalTradesFullAccess` in the "Permissions policies" section
   - Done! ✅

### 🔍 How to Find Your IAM User

If you don't know which IAM user your credentials belong to:

1. Go to AWS IAM Console → Users
2. Look for a user with Access Key ID: `AKIAYTJNKYFJSR5FX7HT`
3. Or run this AWS CLI command:
```bash
aws sts get-caller-identity --profile default
```

This will show you:
- Your IAM user ARN
- Account ID
- User ID

### Alternative: Using AWS CLI

```bash
# Create the policy
aws iam create-policy \
  --policy-name SignalTradesFullAccess \
  --policy-document file://signal-trades-policy.json

# Attach to user (replace YOUR_IAM_USER with your actual username)
aws iam attach-user-policy \
  --user-name YOUR_IAM_USER \
  --policy-arn arn:aws:iam::YOUR_ACCOUNT_ID:policy/SignalTradesFullAccess
```

## 📊 How S3 is Used

### Primary Database
- **All trades** are stored in S3 as the primary database
- **Dashboard** reads from S3 when you view trade history
- **Deployable** anywhere - data is in the cloud
- **Mobile access** - view trades from anywhere

### Storage Structure
```
signal-trades/
└── trades/
    ├── 2026-02-15/
    │   ├── trade-id-1.json
    │   ├── trade-id-2.json
    │   └── trade-id-3.json
    ├── 2026-02-16/
    │   └── trade-id-4.json
    └── ...
```

### Fallback
- Local storage in `trades/` folder is used as backup
- If S3 is unavailable, bot reads from local files
- You can sync local to S3 later

## ✅ Verify Setup

After adding permissions, restart your bot:

```bash
cd /Users/4star/Desktop/Trading/SignalBasedTradingBot
npm run dashboard
```

You should see:
```
✅ AWS S3 client initialized
✅ Trade saved to S3: trades/2026-02-15/xxx.json
```

If you still see permission errors, wait 1-2 minutes for AWS to propagate the changes.

## 🚀 Benefits

With S3 as primary storage:
- ✅ Deploy bot to any server (Heroku, AWS, DigitalOcean, etc.)
- ✅ View trades from mobile/any device
- ✅ No data loss if server restarts
- ✅ Automatic backups (S3 durability: 99.999999999%)
- ✅ Scale to millions of trades
- ✅ Access from multiple dashboard instances

## 🔧 Troubleshooting

### "Access Denied" errors
- Verify user has correct permissions
- Check bucket name is exactly: `signal-trades`
- Ensure IAM user has the policy attached

### Can't see trades in dashboard
- Check S3 bucket has files in `trades/` prefix
- Verify bot has internet connection
- Look for errors in logs

### Want to migrate existing local trades to S3?
Run this command in your bot directory:
```bash
node -e "require('./src/storageManager').syncToS3()"
```
