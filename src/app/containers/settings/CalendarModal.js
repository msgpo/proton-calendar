import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { c } from 'ttag';
import {
    FormModal,
    useLoading,
    useEventManager,
    useApi,
    useNotifications,
    Loader,
    SimpleTabs,
    useGetCalendarBootstrap,
    useGetAddresses,
    useGetAddressKeys,
    useCache,
    GenericError
} from 'react-components';

import {
    createCalendar,
    updateCalendarSettings,
    updateCalendar,
    updateCalendarUserSettings
} from 'proton-shared/lib/api/calendars';
import getPrimaryKey from 'proton-shared/lib/keys/getPrimaryKey';

import CalendarSettingsTab from './CalendarSettingsTab';
import EventSettingsTab from './EventSettingsTab';
import { setupCalendarKeys } from '../setup/resetHelper';
import { getActiveAddresses } from 'proton-shared/lib/helpers/address';
import { noop } from 'proton-shared/lib/helpers/function';
import { loadModels } from 'proton-shared/lib/models/helper';
import { CalendarsModel } from 'proton-shared/lib/models';
import {
    getCalendarModel,
    getCalendarPayload,
    getCalendarSettingsPayload,
    getDefaultModel,
    validate
} from './calendarModalState';

const CalendarModal = ({
    calendar: initialCalendar,
    calendars = [],
    defaultCalendarID,
    defaultColor = false,
    ...rest
}) => {
    const api = useApi();
    const { call } = useEventManager();
    const cache = useCache();
    const getAddresses = useGetAddresses();
    const getCalendarBootstrap = useGetCalendarBootstrap();
    const getAddressKeys = useGetAddressKeys();
    const [loadingSetup, withLoading] = useLoading(true);
    const [loadingAction, withLoadingAction] = useLoading();
    const { createNotification } = useNotifications();

    const [isSubmitted, setIsSubmitted] = useState(false);
    const [error, setError] = useState(false);
    const [calendar, setCalendar] = useState(initialCalendar);
    const [model, setModel] = useState(() => getDefaultModel(defaultColor));

    useEffect(() => {
        const initializeEmptyCalendar = async () => {
            const activeAdresses = getActiveAddresses(await getAddresses());
            if (!activeAdresses.length) {
                setError(true);
                return createNotification({ text: c('Error').t`No valid address found`, type: 'error' });
            }

            setModel((prev) => ({
                ...prev,
                addressID: activeAdresses[0].ID,
                addressOptions: activeAdresses.map(({ ID, Email = '' }) => ({ value: ID, text: Email }))
            }));
        };

        const initializeCalendar = async () => {
            const [{ Members, CalendarSettings }, Addresses] = await Promise.all([
                getCalendarBootstrap(initialCalendar.ID),
                getAddresses()
            ]);

            const [{ Email: memberEmail } = {}] = Members;
            const { ID: AddressID } = Addresses.find(({ Email }) => memberEmail === Email) || {};

            if (!AddressID) {
                setError(true);
                return createNotification({ text: c('Error').t`No valid address found`, type: 'error' });
            }

            setModel((prev) => ({
                ...prev,
                ...getCalendarModel({ Calendar: initialCalendar, CalendarSettings, Addresses, AddressID })
            }));
        };

        const promise = initialCalendar ? initializeCalendar() : initializeEmptyCalendar();

        withLoading(
            promise.catch(() => {
                setError(true);
            })
        );
    }, []);

    const handleCreateCalendar = async (addressID, calendarPayload, calendarSettingsPayload) => {
        const [addresses, addressKeys] = await Promise.all([getAddresses(), getAddressKeys(addressID)]);

        const { privateKey: primaryAddressKey } = getPrimaryKey(addressKeys) || {};
        if (!primaryAddressKey) {
            createNotification({ text: c('Error').t`Primary address key is not decrypted.`, type: 'error' });
            setError(true);
            throw new Error('Missing primary key');
        }

        const { Calendar, Calendar: { ID: newCalendarID } = {} } = await api(
            createCalendar({
                ...calendarPayload,
                AddressID: addressID
            })
        );

        await setupCalendarKeys({
            api,
            calendars: [Calendar],
            addresses,
            getAddressKeys
        }).catch((e) => {
            // Hard failure if the keys fail to setup. Force the user to reload.
            setError(true);
            throw e;
        });

        // Set the calendar in case one of the following calls fails so that it ends up in the update function after this.
        setCalendar(Calendar);

        await Promise.all([
            api(updateCalendarSettings(newCalendarID, calendarSettingsPayload)),
            (() => {
                if (defaultCalendarID) {
                    return;
                }
                const newDefaultCalendarID = calendars.length ? calendars[0].ID : newCalendarID;
                return api(updateCalendarUserSettings({ DefaultCalendarID: newDefaultCalendarID }));
            })()
        ]);

        // Refresh the calendar model in order to ensure flags are correct
        await loadModels([CalendarsModel], { api, cache, useCache: false });
        await call();

        rest.onClose();

        createNotification({ text: c('Success').t`Calendar created` });
    };

    const handleUpdateCalendar = async (calendar, calendarPayload, calendarSettingsPayload) => {
        await Promise.all([
            api(updateCalendar(calendar.ID, calendarPayload)),
            api(updateCalendarSettings(calendar.ID, calendarSettingsPayload))
        ]);
        // Case: Calendar has been created, and keys have been setup, but one of the calendar settings call failed in the creation.
        // Here we are in create -> edit mode. So we have to fetch the calendar model again.
        if (!initialCalendar) {
            await loadModels([CalendarsModel], { api, cache, useCache: false });
        }
        await call();

        rest.onClose();

        createNotification({ text: c('Success').t`Calendar updated` });
    };

    const formattedModel = {
        ...model,
        name: model.name.trim(),
        description: model.description.trim()
    };

    const errors = validate(formattedModel);

    const handleProcessCalendar = async () => {
        const calendarPayload = getCalendarPayload(formattedModel);
        const calendarSettingsPayload = getCalendarSettingsPayload(formattedModel);
        if (calendar) {
            return handleUpdateCalendar(calendar, calendarPayload, calendarSettingsPayload);
        }
        return handleCreateCalendar(formattedModel.addressID, calendarPayload, calendarSettingsPayload);
    };

    const { section, ...modalProps } = (() => {
        if (error) {
            return {
                title: c('Title').t`Error`,
                submit: c('Action').t`Close`,
                hasClose: false,
                section: <GenericError />,
                onSubmit() {
                    window.location.reload();
                }
            };
        }

        const tabs = [
            {
                title: c('Header').t`Calendar settings`,
                content: (
                    <CalendarSettingsTab
                        isSubmitted={isSubmitted}
                        errors={errors}
                        model={model}
                        setModel={setModel}
                        onClose={rest.onClose}
                    />
                )
            },
            {
                title: c('Header').t`Event settings`,
                content: (
                    <EventSettingsTab isSubmitted={isSubmitted} errors={errors} model={model} setModel={setModel} />
                )
            }
        ];

        const isEdit = !!initialCalendar;
        return {
            title: isEdit ? c('Title').t`Update calendar` : c('Title').t`Create calendar`,
            submit: isEdit ? c('Action').t`Update` : c('Action').t`Create`,
            close: c('Action').t`Cancel`,
            loading: loadingSetup || loadingAction,
            section: loadingSetup ? <Loader /> : <SimpleTabs tabs={tabs} />,
            hasClose: true,
            onSubmit: () => {
                setIsSubmitted(true);
                if (Object.keys(errors).length > 0) {
                    return;
                }
                withLoadingAction(handleProcessCalendar());
            }
        };
    })();

    return (
        <FormModal
            title={''}
            className="pm-modal--shorterLabels w100"
            close={null}
            onClose={noop}
            onSubmit={noop}
            submit={c('Action').t`Continue`}
            hasClose={false}
            {...modalProps}
            {...rest}
        >
            {section}
        </FormModal>
    );
};

CalendarModal.propTypes = {
    calendar: PropTypes.object,
    calendars: PropTypes.array,
    defaultCalendarID: PropTypes.oneOfType([PropTypes.string, null]),
    defaultColor: PropTypes.bool,
    members: PropTypes.arrayOf(PropTypes.object)
};

export default CalendarModal;
