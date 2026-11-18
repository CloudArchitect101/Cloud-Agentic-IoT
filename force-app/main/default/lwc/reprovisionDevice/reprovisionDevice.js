// The Re-provision button on a device (Asset). It asks once, then starts the
// certificate rotation in the background: the Asset's Provisioning Status,
// bundle link and expiry change when AWS answers, usually within a minute.
// The checks live in DeviceReprovisionController, so a device that cannot be
// re-provisioned is refused here, at once, instead of turning Failed later.
import { LightningElement, api } from 'lwc';
import { CloseActionScreenEvent } from 'lightning/actions';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import startReprovision from '@salesforce/apex/DeviceReprovisionController.reprovision';

export default class ReprovisionDevice extends LightningElement {
    @api recordId;

    working = false;
    errorMessage;

    async reprovision() {
        this.working = true;
        this.errorMessage = undefined;
        try {
            await startReprovision({ assetId: this.recordId });
            this.dispatchEvent(
                new ShowToastEvent({
                    title: 'Re-provisioning started',
                    message: 'AWS is issuing a new certificate. Refresh the page in a minute to see the new bundle link.',
                    variant: 'success'
                })
            );
            this.close();
        } catch (error) {
            this.errorMessage = (error && error.body && error.body.message) || 'Re-provisioning could not start.';
        } finally {
            this.working = false;
        }
    }

    close() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }
}
