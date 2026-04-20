# Preview Project Workflow

This workflow describes the steps needed to start the preview server and test the project locally.

## Steps

1. **Start the Preview Server**
   Run the following command to start the `http-server` on the `public` directory:
   ```bash
   npx.cmd -y http-server public -p 8080 --cors
   ```
   *Note: This command uses a generic HTTP server to serve the static files in the `public` folder, as defined in `.idx/dev.nix`.*

2. **Access the Application**
   Once the server starts, it will output a local URL (typically `http://127.0.0.1:8080`). Open this URL in your web browser.

3. **Verify Functionality**
   - Ensure that the application loads without major console errors.
   - Perform basic interaction testing to confirm that the web app functions as expected.
